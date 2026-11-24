import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import { loadSemanticContract } from "#root/omp-plugin/semantic-contracts.js";
import { discoverAutomaticVerification } from "#root/omp-plugin/verification-catalog.js";
import { captureDeliveryScope } from "#root/omp-plugin/delivery-scope.js";
import {
  deliveryFindingEligibility,
  deliveryFindingMode,
  validateFindings,
  verificationScope,
} from "#root/omp-plugin/finding-scope.js";
import {
  captureSemanticContext,
  semanticContextMissing,
  validateContextPathLimit,
  validateSemanticCitations,
  validateSourceByteLimit,
} from "#root/omp-plugin/semantic-context.js";
import { captureSemanticContinuation, validateSemanticContinuation } from "#root/omp-plugin/semantic-continuation.js";
import {
  continuationAssessmentPayload,
  continuationBatch,
  continuationReviewPayload,
  validateContinuationAssessment,
} from "#root/omp-plugin/semantic-continuation-review.js";
import { buildSemanticReviewPage, paginateSemanticReview } from "#root/omp-plugin/semantic-review-pages.js";
import { saveTimingAssessment } from "#root/omp-plugin/timing-history.js";
import { claimOperationLock } from "#root/omp-plugin/file-lease.js";
import { currentVerificationRestart } from "#root/omp-plugin/verification-restart.js";

const execFileAsync = promisify(execFile);
const CACHE_DIRECTORY = process.env.OMP_VERIFIER_SEMANTIC_CACHE
  || resolve(tmpdir(), `omp-verifier-semantic-${process.getuid?.() ?? "user"}`);
const GENERATION = process.env.OMP_VERIFIER_GENERATION
  ? JSON.parse(process.env.OMP_VERIFIER_GENERATION) : undefined;
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const MAX_ASSESSMENT_LENGTH = 4_000;
const LOCK_WAIT_MS = 15_000;
const SELECTION_REASONS = new Set([
  "automatic-normal",
  "explicit-check",
  "manual-automatic",
  "default-normal",
  "explicit-quick-tweak",
  "explicit-normal",
  "explicit-rearchitecture",
  "full-delivery",
  "ambiguous-declaration",
  "unknown-declaration",
  "unrecorded",
]);

const MAX_CACHED_REQUESTS = 100;
const MAX_CACHED_CHECKS = 200;
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function blocked(id, summary, evidence) {
  return { id, status: "BLOCKED", summary, ...(evidence ? { evidence } : {}) };
}

function validText(value, name, { optional = false, maxLength = MAX_ASSESSMENT_LENGTH } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > maxLength) {
    throw new Error(`${name} must be a ${optional ? "string" : "non-empty string"} no longer than ${maxLength} characters`);
  }
  return value;
}

function projectCacheDirectory(repositoryRoot) {
  return join(CACHE_DIRECTORY, hash(repositoryRoot));
}

function checkCacheKey(checkId) {
  return hash(checkId);
}

function statePath(cacheDirectory, checkId) {
  return join(cacheDirectory, "states", `${checkCacheKey(checkId)}.json`);
}

function lockPath(cacheDirectory, checkId) {
  return join(cacheDirectory, "locks", `${checkCacheKey(checkId)}.lock`);
}

function requestFileName(checkId, requestId) {
  return `${Buffer.from(checkId).toString("base64url")}.${requestId}.json`;
}

export class InvalidSemanticRequestFilename extends Error {
  constructor() {
    super("Invalid review request filename.");
  }
}

function checkIdFromRequestPath(requestPath) {
  const match = basename(requestPath).match(/^([A-Za-z0-9_-]+)\.([0-9a-f-]{36})\.json$/);
  if (!match) {
    throw new InvalidSemanticRequestFilename();
  }
  const checkId = Buffer.from(match[1], "base64url").toString("utf8");
  if (!/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(checkId)) {
    throw new InvalidSemanticRequestFilename();
  }
  return { checkId, requestId: match[2] };
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicWrite(filePath, contents) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function withCheckLock(cacheDirectory, checkId, callback) {
  const locksDirectory = join(cacheDirectory, "locks");
  await ensurePrivateDirectory(locksDirectory);
  const filePath = lockPath(cacheDirectory, checkId);
  const release = await claimOperationLock(filePath, LOCK_WAIT_MS, `semantic request state is busy: ${filePath}; finish its owner operation`);

  let completedAssessment;
  try {
    const operationStartedAt = performance.now();
    const operationStartedWall = Date.now();
    const result = await callback();
    const state = await readCurrentState(cacheDirectory, checkId);
    if (state?.diagnostics && state.diagnostics.completedAt === undefined) {
      const now = Date.now();
      const diagnostics = state.diagnostics;
      // A renewal starts a new clock; do not charge its predecessor's work twice.
      const elapsed = performance.now() - operationStartedAt;
      const requestElapsed = Math.max(0, now - Math.max(operationStartedWall, diagnostics.createdAt));
      diagnostics.coordinatorMs += Math.min(elapsed, requestElapsed);
      diagnostics.operations += 1;
      diagnostics.lastOperationAt = now;
      if (state.consumed) diagnostics.completedAt = now;
      await atomicWrite(statePath(cacheDirectory, checkId), JSON.stringify(state));
      if (state.consumed) {
        // Only accepted terminal results close a timing interval. Rejected
        // assessments also return BLOCKED but do not consume the request.
        completedAssessment = {
          requestId: state.requestId,
          status: state.finalResult.status,
          completedAt: now,
        };
      }
    }
    return result;
  } finally {
    await release();
    if (completedAssessment) {
      // History retention must not hold up another operation on the check lock.
      await saveTimingAssessment(completedAssessment).catch(() => {});
    }
  }
}

async function currentRepositoryRoot(cwd) {
  let resolvedCwd = await realpath(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["-C", resolvedCwd, "rev-parse", "--show-toplevel"], {
      maxBuffer: 4_000_000,
    });
    resolvedCwd = await realpath(stdout.trim());
  } catch {
    // Non-git projects use the supplied working directory as their root.
  }
  return resolvedCwd;
}

async function pruneDirectory(directory, maximumEntries) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const filePath = join(directory, entry.name);
    try {
      files.push({ path: filePath, modifiedAt: (await stat(filePath)).mtimeMs });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (files.length <= maximumEntries) return;

  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  await Promise.all(files.slice(maximumEntries).map(file => rm(file.path, { force: true })));
}

async function requestCacheRoot(repositoryRoot) {
  const cacheDirectory = projectCacheDirectory(repositoryRoot);
  await ensurePrivateDirectory(cacheDirectory);
  const requestsDirectory = join(cacheDirectory, "requests");
  const statesDirectory = join(cacheDirectory, "states");
  await ensurePrivateDirectory(requestsDirectory);
  await ensurePrivateDirectory(statesDirectory);
  // Generation collection needs every pending state, including quiet projects.
  // Legacy caches retain their existing bounded retention policy.
  if (!GENERATION) {
    await pruneDirectory(requestsDirectory, MAX_CACHED_REQUESTS);
    await pruneDirectory(statesDirectory, MAX_CACHED_CHECKS);
  }
  return cacheDirectory;
}

async function readCurrentState(cacheDirectory, checkId) {
  try {
    return JSON.parse(await readFile(statePath(cacheDirectory, checkId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`could not read semantic request state: ${error.message}`, { cause: error });
  }
}

async function readStoredRequest(cacheDirectory, checkId, requestId, { requireCurrent = true } = {}) {
  const currentState = await readCurrentState(cacheDirectory, checkId);
  if (!currentState || (requireCurrent && currentState.requestId !== requestId)) {
    throw new Error("semantic request has been superseded");
  }
  if (requireCurrent && currentState.consumed) throw new Error("semantic request has already been consumed");

  const requestPath = join(cacheDirectory, "requests", requestFileName(checkId, requestId));
  let contents;
  try {
    contents = await readFile(requestPath);
  } catch (error) {
    throw new Error(`semantic request file is unavailable: ${error.message}`, { cause: error });
  }
  if (hash(contents) !== currentState.requestHash) throw new Error("semantic request file was tampered with");

  let stored;
  try {
    stored = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error("semantic request file is not valid JSON");
  }
  if (stored?.payload?.requestId !== requestId || stored?.payload?.check?.id !== checkId) {
    throw new Error("semantic request identity does not match its cache entry");
  }
  return { requestPath, currentState, stored };
}

async function previousRequest(cacheDirectory, checkId) {
  try {
    const currentState = await readCurrentState(cacheDirectory, checkId);
    if (!currentState?.requestId) return undefined;
    return (await readStoredRequest(cacheDirectory, checkId, currentState.requestId, { requireCurrent: false })).stored;
  } catch {
    return undefined;
  }
}

async function currentDefinition(check) {
  let manifestContents;
  try {
    manifestContents = await readFile(check.manifestPath, "utf8");
  } catch (error) {
    throw new Error(`plugin manifest is unavailable: ${error.message}`, { cause: error });
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestContents);
  } catch (error) {
    throw new Error(`plugin manifest is not valid JSON: ${error.message}`, { cause: error });
  }
  const entries = manifest?.omp?.verifications;
  const entry = Array.isArray(entries) ? entries.find(candidate => candidate?.id === check.id) : undefined;
  if (!entry || entry.mode !== "agentic") throw new Error("plugin manifest no longer declares this agentic check");

  const packageName = typeof manifest.name === "string" && manifest.name ? manifest.name : check.packageName;
  const contract = await loadSemanticContract({
    checkId: check.id,
    packageName,
    packageVersion: typeof manifest.version === "string" ? manifest.version : undefined,
    packagePath: check.packagePath,
    contractReference: entry.contract,
  });
  return {
    label: validText(entry.label, "label"),
    description: validText(entry.description, "description"),
    manifestHash: hash(manifestContents),
    contract,
  };
}


function previousSourceContext(payload) {
  if (!payload?.continuation) return payload?.context;
  return {
    ...payload.context,
    changedCode: payload.continuation.batches.flatMap(batch => batch.context.changedCode),
    changedCodeCoverage: payload.continuation.batches.flatMap(batch => batch.context.changedCodeCoverage ?? []),
  };
}

async function captureRequest({
  check,
  repositoryRoot,
  changedPaths,
  contextPaths,
  callerContextPaths = [],
  externalContextPaths = [],
  previousContext,
  maxSourceBytes,
  maxContextPaths,
  sourceRecovery,
  automaticScope,
  continuation = false,
  selectionReason,
  renewalReason = "initial",
  previousRequestId,
}) {
  const createdAt = Date.now();
  const captureStartedAt = performance.now();
  const sourceByteLimit = validateSourceByteLimit(maxSourceBytes);
  const definition = await currentDefinition(check);
  const captured = await captureSemanticContext({
    repositoryRoot,
    changedPaths,
    contextPaths,
    callerContextPaths,
    externalContextPaths,
    previousContext,
    maxSourceBytes: sourceByteLimit,
    maxContextPaths,
    sourceRecovery,
    delivery: automaticScope?.delivery,
  });
  const missingContext = semanticContextMissing(definition.contract.requiredContext, captured);
  const requestId = randomUUID();
  const payload = {
    version: 1,
    requestId,
    ...(GENERATION ? { generation: GENERATION } : {}),
    nonce: randomUUID(),
    check: {
      id: check.id,
      label: definition.label,
      description: definition.description,
    },
    standard: {
      id: definition.contract.standardId,
      source: definition.contract.source,
      sourceDetails: definition.contract.sourceDetails,
      gold: definition.contract.gold,
      requiredContext: definition.contract.requiredContext,
      rubric: definition.contract.rubric,
    },
    scope: {
      repositoryRoot,
      changedPaths: captured.context.changedPaths,
      findingMode: deliveryFindingMode(automaticScope?.delivery, captured.context.changedPaths),
      contextPaths: [...contextPaths],
      callerContextPaths: [...callerContextPaths],
      ...(externalContextPaths.length ? { externalContextPaths: [...externalContextPaths] } : {}),
      maxSourceBytes: sourceByteLimit,
      ...(maxContextPaths === undefined ? {} : {
        maxContextPaths,
      }),
      ...(sourceRecovery ? { sourceRecovery: { ...sourceRecovery } } : {}),
      ...(automaticScope ? { automatic: automaticScope } : {}),
    },
    context: captured.context,
    missingContext,
  };
  if (continuation) {
    payload.continuation = await captureSemanticContinuation({
      repositoryRoot,
      changedPaths: payload.scope.changedPaths,
      contextPaths,
      callerContextPaths,
      externalContextPaths,
      externalSnapshot: captured.context.externalContext,
      previousContext,
      maxSourceBytes: sourceByteLimit,
      maxContextPaths,
      sourceRecovery,
      automaticScope,
    }, definition.contract.requiredContext);
  }
  const stored = {
    payload,
    diagnostics: {
      createdAt,
      captureMs: performance.now() - captureStartedAt,
      selectionReason: selectionReason === undefined ? (automaticScope ? "automatic-normal" : "explicit-check")
        : SELECTION_REASONS.has(selectionReason) ? selectionReason : "unrecorded",
      renewalReason,
      previousRequestId,
    },
    runtime: {
      manifestPath: check.manifestPath,
      packagePath: check.packagePath,
      manifestHash: definition.manifestHash,
      contractHash: definition.contract.contractHash,
      sourceHash: definition.contract.sourceHash,
      contextFingerprint: captured.fingerprint,
    },
  };
  return { requestId, payload, stored };
}

function requestEnvelope(payload, requestPath, state = {}, batchIndex) {
  payload = continuationReviewPayload(payload, state, batchIndex);
  let summary = "Semantic evaluation is ready for assessment";
  if (payload.missingContext.length) {
    summary = "Semantic evaluation awaits required context";
  }
  if (payload.continuation) {
    summary = payload.continuation.phase === "batch"
      ? "Semantic continuation awaits a batch checkpoint; the whole review remains pending"
      : "Semantic continuation awaits the final whole-scope assessment";
  }

  return {
    id: payload.check.id,
    status: "PENDING",
    summary,
    ...(payload.missingContext.length ? { evidence: payload.missingContext.join("; ") } : {}),
    reviewRequest: { ...payload, path: requestPath },
  };
}

async function persistRequest(cacheDirectory, checkId, requestPath, stored) {
  const requestContents = JSON.stringify(stored);
  await atomicWrite(requestPath, requestContents);
  const state = {
    requestId: stored.payload.requestId,
    requestHash: hash(requestContents),
    consumed: false,
    diagnostics: {
      ...stored.diagnostics,
      coordinatorMs: 0,
      operations: 0,
    },
  };
  await atomicWrite(statePath(cacheDirectory, checkId), JSON.stringify(state));
}

async function loadRequestForOperation({ cwd, requestPath }) {
  const repositoryRoot = await currentRepositoryRoot(cwd);
  const cacheDirectory = projectCacheDirectory(repositoryRoot);
  const requestsDirectory = join(cacheDirectory, "requests");
  const absoluteRequestPath = resolve(cwd, requestPath);
  if (dirname(absoluteRequestPath) !== requestsDirectory) {
    throw new Error("request file is outside this project's private semantic request cache");
  }
  const { checkId, requestId } = checkIdFromRequestPath(absoluteRequestPath);
  return { repositoryRoot, cacheDirectory, absoluteRequestPath, checkId, requestId };
}

async function validateFreshness({ checkId, repositoryRoot, stored }) {
  const { payload, runtime } = stored;
  const delivery = payload.scope.automatic?.delivery;
  if (payload.scope.findingMode !== deliveryFindingMode(delivery, payload.scope.changedPaths)) {
    throw new Error("request predates current finding attribution; prepare fresh verification with the complete current scope");
  }
  // Older stored requests have no source cap and retain their original fingerprint shape.
  const usesLegacySourceLimit = payload.scope.maxSourceBytes === undefined;
  const sourceByteLimit = validateSourceByteLimit(payload.scope.maxSourceBytes);
  if (payload.scope.repositoryRoot !== repositoryRoot) throw new Error("request project root no longer matches the active project");
  const check = {
    id: checkId,
    packageName: payload.standard.sourceDetails.package,
    packagePath: runtime.packagePath,
    manifestPath: runtime.manifestPath,
  };
  const definition = await currentDefinition(check);
  if (definition.manifestHash !== runtime.manifestHash
    || definition.contract.contractHash !== runtime.contractHash
    || definition.contract.sourceHash !== runtime.sourceHash) {
    throw new Error("supplied standard or provider manifest changed after the request was prepared");
  }

  const captured = await captureSemanticContext({
    repositoryRoot,
    changedPaths: payload.scope.changedPaths,
    contextPaths: payload.scope.contextPaths,
    callerContextPaths: payload.scope.callerContextPaths,
    externalContextPaths: payload.scope.externalContextPaths,
    externalSnapshot: payload.context.externalContext,
    previousContext: previousSourceContext(payload),
    maxSourceBytes: sourceByteLimit,
    maxContextPaths: payload.scope.maxContextPaths,
    sourceRecovery: payload.scope.sourceRecovery,
    legacyRequest: usesLegacySourceLimit,
    delivery,
  });
  if (captured.fingerprint !== runtime.contextFingerprint || captured.fingerprint !== payload.context.fingerprint) {
    throw new Error("captured source or project context changed after the request was prepared");
  }
  if (usesLegacySourceLimit) {
    payload.scope.maxSourceBytes = sourceByteLimit;
    payload.context.evidenceBudget.maxSourceBytes = sourceByteLimit;
  }
  if (payload.continuation) await validateSemanticContinuation(payload);
}

function requestBlock(id, error) {
  const unavailable = blocked(id || "semantic-evaluation", "Semantic request is unavailable", error);
  return {
    ...unavailable,
    nextCheck: "Restore the named request prerequisite, then prepare fresh verification with the original complete scope and actual delivery base. Do not reuse citations from an unavailable or stale request.",
  };
}

async function reconcileAutomaticScope(target, current) {
  const { payload, runtime } = current.stored;
  const automatic = payload.scope.automatic;
  if (!automatic) return undefined;
  if (payload.scope.repositoryRoot !== target.repositoryRoot) {
    throw new Error("request project root no longer matches the active project");
  }

  const delivery = await captureDeliveryScope({
    repositoryRoot: target.repositoryRoot,
    baseRef: automatic.delivery.baseRef,
    candidatePaths: automatic.delivery.candidatePaths,
    wholeFilePaths: automatic.delivery.wholeFilePaths,
  });
  const plan = await discoverAutomaticVerification({
    repositoryRoot: target.repositoryRoot,
    changedPaths: delivery.changedPaths,
    packageDirectory: automatic.packageDirectory,
    workLevel: automatic.workLevel,
  });
  const blockers = plan.results.filter(result => result.status === "BLOCKED");
  if (blockers.length) {
    throw new Error(blockers.map(result => `${result.id}: ${result.summary}${result.evidence ? `: ${result.evidence}` : ""}`).join("; "));
  }
  const selection = plan.selections.find(({ check }) => check.id === target.checkId);
  if (!selection?.matches.length) {
    return {
      id: target.checkId,
      status: "SUPERSEDED",
      summary: "The automatic check no longer applies to the current delivery scope",
      evaluation: { mode: "agentic", requestId: target.requestId },
    };
  }
  if (selection.check.mode !== "agentic") {
    throw new Error("the current provider now declares a deterministic check; rerun automatic verification against the delivery base");
  }

  const changedPaths = [...new Set(selection.matches.map(match => match.path))].sort();
  const sameScope = JSON.stringify(delivery) === JSON.stringify(automatic.delivery)
    && JSON.stringify(changedPaths) === JSON.stringify(payload.scope.changedPaths)
    && selection.check.manifestPath === runtime.manifestPath;
  if (sameScope) {
    try {
      await validateFreshness({ checkId: target.checkId, repositoryRoot: target.repositoryRoot, stored: current.stored });
      return undefined;
    } catch {
      // Integrity was checked before this call. Changed evidence needs a new
      // request, never the old assessment or its page-completion receipts.
    }
  }
  const captured = await captureRequest({
    check: selection.check,
    repositoryRoot: target.repositoryRoot,
    changedPaths,
    contextPaths: payload.scope.contextPaths,
    callerContextPaths: payload.scope.callerContextPaths,
    externalContextPaths: payload.scope.externalContextPaths,
    previousContext: previousSourceContext(payload),
    maxSourceBytes: payload.scope.maxSourceBytes,
    maxContextPaths: payload.scope.maxContextPaths,
    sourceRecovery: payload.scope.sourceRecovery,
    continuation: Boolean(payload.continuation),
    automaticScope: { packageDirectory: plan.packageDirectory, delivery, ...(automatic.workLevel ? { workLevel: automatic.workLevel } : {}) },
    selectionReason: current.stored.diagnostics?.selectionReason,
    renewalReason: sameScope ? "evidence-or-provider-changed" : "delivery-scope-changed",
    previousRequestId: payload.requestId,
  });
  const requestPath = join(target.cacheDirectory, "requests", requestFileName(target.checkId, captured.requestId));
  await persistRequest(target.cacheDirectory, target.checkId, requestPath, captured.stored);
  return {
    ...requestEnvelope(captured.payload, requestPath),
    evaluation: { mode: "agentic", requestId: target.requestId, supersededBy: captured.requestId },
  };
}

async function reconcileRequest(target) {
  const currentState = await readCurrentState(target.cacheDirectory, target.checkId);
  const isCurrent = currentState?.requestId === target.requestId;
  if (!currentState) throw new Error("semantic request has been superseded");

  const current = await readStoredRequest(target.cacheDirectory, target.checkId, currentState.requestId, {
    requireCurrent: false,
  });
  const automaticResult = await reconcileAutomaticScope(target, current);
  if (automaticResult) return { result: automaticResult };
  if (!current.stored.payload.scope.automatic) {
    await validateFreshness({
      checkId: target.checkId,
      repositoryRoot: target.repositoryRoot,
      stored: current.stored,
    });
  }
  if (isCurrent && !currentState.consumed) return current;
  if (isCurrent) {
    const result = currentState.finalResult;
    if (result?.id !== target.checkId || result.evaluation?.requestId !== target.requestId
      || !STATUSES.has(result.status)) {
      throw new Error("completed semantic request has no retained final result; prepare fresh verification");
    }
    return { result };
  }

  const evaluation = {
    mode: "agentic",
    requestId: target.requestId,
    supersededBy: currentState.requestId,
  };
  if (currentState.consumed) {
    return { result: {
      id: target.checkId,
      status: "SUPERSEDED",
      summary: "Obsolete semantic operation skipped; the current request has already been assessed",
      evaluation,
    } };
  }

  return { result: {
    ...requestEnvelope(current.stored.payload, current.requestPath, currentState),
    evaluation,
  } };
}

function automaticEvidenceScope(automatic, changedPaths) {
  if (!automatic) {
    return undefined;
  }
  const { delivery } = automatic;
  const eligibility = deliveryFindingEligibility(delivery, changedPaths);
  return {
    packageDirectory: automatic.packageDirectory,
    workLevel: automatic.workLevel,
    baseRef: delivery.baseRef,
    baseCommit: delivery.baseCommit,
    mergeBaseCommit: delivery.mergeBaseCommit,
    wholeFileSelectors: delivery.wholeFilePaths,
    eligibility,
  };
}

async function reusableResult({ cacheDirectory, check, repositoryRoot, changedPaths, contextPaths, maxSourceBytes, sourceRecovery, automaticScope, restartId, reuseExisting }) {
  try {
    const state = await readCurrentState(cacheDirectory, check.id);
    if (!state?.requestId) return undefined;
    if (!reuseExisting && state.requestId !== restartId) {
      return undefined;
    }

    const { stored, requestPath } = await readStoredRequest(cacheDirectory, check.id, state.requestId, {
      requireCurrent: false,
    });
    const { payload, runtime } = stored;
    const result = state.finalResult;
    if (state.consumed && (result?.id !== check.id || result.evaluation?.mode !== "agentic"
      || result.evaluation.requestId !== state.requestId || !STATUSES.has(result.status))) return undefined;

    const selectedPaths = [...new Set(changedPaths)].sort();
    if (payload.scope.repositoryRoot !== repositoryRoot
      || runtime.manifestPath !== check.manifestPath || runtime.packagePath !== check.packagePath
      || !isDeepStrictEqual(payload.scope.changedPaths, selectedPaths)
      || !contextPaths.every(selector => payload.scope.contextPaths.includes(selector))
      || payload.scope.maxSourceBytes !== maxSourceBytes
      || !isDeepStrictEqual(payload.scope.sourceRecovery, sourceRecovery)
      || !isDeepStrictEqual(automaticEvidenceScope(payload.scope.automatic, selectedPaths), automaticEvidenceScope(automaticScope, selectedPaths))) {
      return undefined;
    }

    // Validate the whole capture, including selectors enrolled during review.
    // A narrower automatic invocation must not silently discard material evidence.
    await validateFreshness({ checkId: check.id, repositoryRoot, stored });
    if (state.consumed) {
      return result;
    }

    const pending = requestEnvelope(payload, requestPath, state);
    if (restartId === state.requestId) {
      const view = paginateSemanticReview(pending);
      const { nextPage } = reviewPageProgress(view, state);
      pending.reviewProgress = {
        nextPage: nextPage ?? (view.count - 1),
      };
    }
    return pending;
  } catch {
    // Missing, damaged, or stale prior proof is not an execution failure.
    // Normal capture below must establish a fresh request instead.
    return undefined;
  }
}

export async function prepareSemanticEvaluation({
  check,
  cwd,
  changedPaths = [],
  repositoryRoot = cwd,
  contextPaths = [],
  maxSourceBytes,
  sourceRecovery,
  automaticScope,
  reuseExisting = false,
  selectionReason,
}) {
  if (!check || check.mode !== "agentic" || !check.manifestPath || !check.packagePath) {
    return blocked(check?.id || "semantic-evaluation", "Semantic verification check is not supported by this runtime");
  }

  try {
    const sourceByteLimit = validateSourceByteLimit(maxSourceBytes);
    const root = await realpath(repositoryRoot);
    const cacheDirectory = await requestCacheRoot(root);
    return await withCheckLock(cacheDirectory, check.id, async () => {
      const restart = currentVerificationRestart();
      const key = `semantic:${check.id}`;
      const restartId = await restart?.read(key);
      if (reuseExisting || typeof restartId === "string") {
        const accepted = await reusableResult({
          cacheDirectory, check, repositoryRoot: root, changedPaths, contextPaths,
          maxSourceBytes: sourceByteLimit, sourceRecovery, automaticScope,
          restartId,
          reuseExisting,
        });
        if (accepted) {
          if (accepted.reviewRequest) {
            await restart?.save(key, accepted.reviewRequest.requestId);
          }
          return accepted;
        }
      }
      const previous = await previousRequest(cacheDirectory, check.id);
      const isSameEvidenceScope = previous?.payload.scope.repositoryRoot === root
        && previous.runtime.manifestPath === check.manifestPath && previous.runtime.packagePath === check.packagePath
        && isDeepStrictEqual(previous.payload.scope.changedPaths, [...new Set(changedPaths)].sort());
      const retainedScope = reuseExisting && isSameEvidenceScope ? previous.payload.scope : undefined;
      const result = await captureRequest({
        check,
        repositoryRoot: root,
        changedPaths,
        contextPaths: [...new Set([...(retainedScope?.contextPaths ?? []), ...contextPaths])],
        callerContextPaths: retainedScope?.callerContextPaths,
        externalContextPaths: retainedScope?.externalContextPaths,
        previousContext: previousSourceContext(previous?.payload),
        maxSourceBytes: sourceByteLimit,
        maxContextPaths: retainedScope?.maxContextPaths,
        sourceRecovery,
        automaticScope,
        continuation: isSameEvidenceScope && Boolean(previous?.payload.continuation),
        selectionReason,
        renewalReason: previous ? (reuseExisting ? "evidence-scope-provider-or-policy-changed" : "fresh-preparation") : "initial",
        previousRequestId: previous?.payload.requestId,
      });
      const requestPath = join(cacheDirectory, "requests", requestFileName(check.id, result.requestId));
      await persistRequest(cacheDirectory, check.id, requestPath, result.stored);
      await restart?.save(key, result.requestId);
      return requestEnvelope(result.payload, requestPath);
    });
  } catch (error) {
    return requestBlock(check.id, error.message);
  }
}

export async function readSemanticEvaluation({
  cwd, requestPath, contextPaths = [], callerContextPaths = [], externalContextPaths = [],
  removeContextPaths = [], continuation = false, batchIndex, maxContextPaths, resume = false,
}) {
  let target;
  try {
    target = await loadRequestForOperation({ cwd, requestPath });
  } catch (error) {
    if (error instanceof InvalidSemanticRequestFilename) {
      throw error;
    }

    return requestBlock(undefined, error.message);
  }

  try {
    return await withCheckLock(target.cacheDirectory, target.checkId, async () => {
      if (typeof resume !== "boolean") {
        throw new Error("resume must be a boolean");
      }
      if (resume && (continuation || batchIndex !== undefined || maxContextPaths !== undefined
        || [contextPaths, callerContextPaths, externalContextPaths, removeContextPaths]
          .some(paths => !Array.isArray(paths) || paths.length > 0))) {
        throw new Error("resume cannot be combined with continuation renewal, batch selection, or context options");
      }

      const { result: reconciled, stored, currentState } = await reconcileRequest(target);
      if (reconciled) {
        if (resume && reconciled.reviewRequest) {
          return {
            ...reconciled,
            reviewPage: buildSemanticReviewPage(reconciled),
          };
        }

        return reconciled;
      }
      if (resume) {
        const result = requestEnvelope(stored.payload, target.absoluteRequestPath, currentState);
        const view = paginateSemanticReview(result);
        const { nextPage } = reviewPageProgress(view, currentState);
        const pageIndex = nextPage ?? (view.count - 1);
        return {
          ...result,
          reviewPage: view.page(pageIndex),
        };
      }

      if (!Array.isArray(contextPaths)) throw new Error("contextPaths must be an array of project-relative paths");
      if (!Array.isArray(callerContextPaths)) throw new Error("callerContextPaths must be an array of project-relative paths");
      if (!Array.isArray(externalContextPaths)) throw new Error("externalContextPaths must be an array of pinned external selectors");
      if (!Array.isArray(removeContextPaths)) throw new Error("removeContextPaths must be an array of retained selectors");
      const previousContextPaths = stored.payload.scope.contextPaths;
      const previousCallerContext = stored.payload.scope.callerContextPaths ?? [];
      const previousExternalContext = stored.payload.scope.externalContextPaths ?? [];
      const retainedSelectors = new Set([...previousContextPaths, ...previousCallerContext, ...previousExternalContext]);
      const removedSelectors = new Set(removeContextPaths);
      for (const selector of removedSelectors) {
        if (!retainedSelectors.has(selector)) throw new Error(`context selector is not retained: ${selector}`);
      }
      const additionalContextPaths = [...new Set([
        ...previousContextPaths.filter(selector => !removedSelectors.has(selector)),
        ...contextPaths,
      ])];
      const additionalCallerContext = [...new Set([
        ...previousCallerContext.filter(selector => !removedSelectors.has(selector)),
        ...callerContextPaths,
      ])];
      const additionalExternalContext = [...new Set([
        ...previousExternalContext.filter(selector => !removedSelectors.has(selector)),
        ...externalContextPaths,
      ])];
      const requestedContextPathLimit = maxContextPaths === undefined ? stored.payload.scope.maxContextPaths : maxContextPaths;
      const contextPathLimit = validateContextPathLimit(requestedContextPathLimit);
      const hasLimitChange = maxContextPaths !== undefined && maxContextPaths !== stored.payload.scope.maxContextPaths;
      const hasContextChanges = removedSelectors.size > 0
        || additionalContextPaths.length !== previousContextPaths.length
        || additionalCallerContext.length !== previousCallerContext.length
        || additionalExternalContext.length !== previousExternalContext.length;
      if (typeof continuation !== "boolean") throw new Error("continuation must be a boolean");
      if (batchIndex !== undefined && (continuation || hasContextChanges || hasLimitChange)) {
        throw new Error("batch selection cannot be combined with continuation renewal, context changes, or selector-limit changes");
      }
      if (!hasContextChanges && !continuation && !hasLimitChange) {
        return requestEnvelope(stored.payload, target.absoluteRequestPath, currentState, batchIndex);
      }

      const check = {
        id: target.checkId,
        mode: "agentic",
        manifestPath: stored.runtime.manifestPath,
        packagePath: stored.runtime.packagePath,
        packageName: stored.payload.standard.sourceDetails.package,
      };
      const result = await captureRequest({
        check,
        repositoryRoot: target.repositoryRoot,
        changedPaths: stored.payload.scope.changedPaths,
        contextPaths: additionalContextPaths,
        callerContextPaths: additionalCallerContext,
        externalContextPaths: additionalExternalContext,
        maxSourceBytes: stored.payload.scope.maxSourceBytes,
        maxContextPaths: maxContextPaths === undefined ? stored.payload.scope.maxContextPaths : contextPathLimit,
        sourceRecovery: stored.payload.scope.sourceRecovery,
        previousContext: previousSourceContext(stored.payload),
        automaticScope: stored.payload.scope.automatic,
        continuation: continuation || Boolean(stored.payload.continuation),
        selectionReason: stored.diagnostics?.selectionReason,
        renewalReason: hasLimitChange ? "selector-limit-changed" : hasContextChanges ? "context-enrichment" : "bounded-continuation",
        previousRequestId: stored.payload.requestId,
      });
      const nextRequestPath = join(target.cacheDirectory, "requests", requestFileName(target.checkId, result.requestId));
      await persistRequest(target.cacheDirectory, target.checkId, nextRequestPath, result.stored);
      return requestEnvelope(result.payload, nextRequestPath);
    });
  } catch (error) {
    return requestBlock(target.checkId, error.message);
  }
}

export async function recordSemanticReviewPage({ cwd, page }) {
  if (!page || !Number.isSafeInteger(page.index) || !Number.isSafeInteger(page.count)
    || page.index < 0 || page.count < 1 || page.index >= page.count
    || !/^[a-f0-9]{64}$/.test(page.viewFingerprint)) {
    throw new Error("semantic review page identity is invalid");
  }

  const target = await loadRequestForOperation({ cwd, requestPath: page.path });
  if (page.requestId !== target.requestId) {
    throw new Error("semantic review page requestId does not match its request path");
  }

  await withCheckLock(target.cacheDirectory, target.checkId, async () => {
    const { currentState, stored } = await readStoredRequest(target.cacheDirectory, target.checkId, target.requestId);
    const isBatch = page.batchIndex !== undefined;
    if (isBatch) continuationBatch(stored.payload, page.batchIndex);
    const previous = isBatch ? currentState.batchPagePresentations?.[page.batchIndex] : currentState.pagePresentation;
    let deliveredPages = [];
    if (previous?.viewFingerprint === page.viewFingerprint && previous.count === page.count) {
      deliveredPages = previous.deliveredPages;
    }

    const delivered = new Set(deliveredPages);
    delivered.add(page.index);
    const presentation = {
      viewFingerprint: page.viewFingerprint,
      count: page.count,
      deliveredPages: [...delivered].sort((left, right) => left - right),
      totalBytes: page.totalBytes,
      deliveries: (previous?.viewFingerprint === page.viewFingerprint ? previous.deliveries ?? deliveredPages.length : 0) + 1,
    };
    const nextState = { ...currentState };
    if (isBatch) {
      nextState.batchPagePresentations = { ...currentState.batchPagePresentations, [page.batchIndex]: presentation };
    } else {
      nextState.pagePresentation = presentation;
    }
    await atomicWrite(statePath(target.cacheDirectory, target.checkId), JSON.stringify(nextState));
  });
}

function reviewPageProgress(view, state) {
  const presentation = view.batchIndex === undefined
    ? state.pagePresentation
    : state.batchPagePresentations?.[view.batchIndex];
  const sameView = presentation?.viewFingerprint === view.viewFingerprint && presentation.count === view.count;
  const delivered = new Set(sameView ? presentation.deliveredPages : []);
  let firstUnreadPage = 0;
  while (delivered.has(firstUnreadPage)) firstUnreadPage += 1;
  let repeatedPages = 0;
  if (sameView) {
    repeatedPages = Math.max(0, (presentation.deliveries ?? delivered.size) - delivered.size);
  }

  return {
    uniquePages: delivered.size,
    repeatedPages,
    nextPage: firstUnreadPage < view.count ? firstUnreadPage : null,
  };
}

function diagnosticNextAction(superseded, phase) {
  if (superseded || phase === "reading-pages") {
    return "resume-review";
  }
  if (phase === "context-recovery") {
    return "recover-context";
  }
  if (phase === "awaiting-assessment") {
    return "evaluate";
  }

  return null;
}

// Observation only: never reconciles scope, records page delivery, or approves freshness.
export async function readSemanticDiagnostics({ cwd, requestPath }) {
  const target = await loadRequestForOperation({
    cwd,
    requestPath,
  });
  const state = await readCurrentState(target.cacheDirectory, target.checkId);
  if (!state) throw new Error("No current semantic request");
  const { stored, currentState, requestPath: currentPath } = await readStoredRequest(
    target.cacheDirectory,
    target.checkId,
    state.requestId,
    {
      requireCurrent: false,
    },
  );
  const result = requestEnvelope(stored.payload, currentPath, currentState);
  const view = paginateSemanticReview(result);
  const progress = reviewPageProgress(view, currentState);
  const superseded = target.requestId !== currentState.requestId;
  const diagnostics = currentState.diagnostics;
  const wallAgeMs = diagnostics ? Math.max(0, (diagnostics.completedAt ?? Date.now()) - diagnostics.createdAt) : null;
  const status = currentState.consumed ? currentState.finalResult.status : "PENDING";
  let phase = "awaiting-assessment";
  if (currentState.consumed) {
    phase = "complete";
  } else if (result.reviewRequest.missingContext.length) {
    phase = "context-recovery";
  } else if (progress.nextPage !== null) {
    phase = "reading-pages";
  }

  const nextAction = diagnosticNextAction(superseded, phase);
  return {
    checkId: target.checkId,
    requestedId: target.requestId,
    currentId: currentState.requestId,
    superseded,
    status,
    phase,
    nextAction,
    freshness: "not-checked",
    selection: {
      reason: diagnostics?.selectionReason ?? "unrecorded",
      changedPaths: stored.payload.scope.changedPaths.length,
      contextSelectors: stored.payload.scope.contextPaths.length
        + (stored.payload.scope.callerContextPaths?.length ?? 0)
        + (stored.payload.scope.externalContextPaths?.length ?? 0),
    },
    renewal: {
      reason: diagnostics?.renewalReason ?? "unrecorded",
      previousRequestId: diagnostics?.previousRequestId ?? null,
    },
    progress: {
      payloadBytes: view.totalBytes,
      pages: view.count,
      ...progress,
      batchIndex: view.batchIndex ?? null,
      batches: stored.payload.continuation?.batches.length ?? 0,
      completedBatches: Object.keys(currentState.batchAssessments ?? {}).length,
    },
    timing: {
      wallAgeMs,
      captureMs: diagnostics?.captureMs ?? null,
      coordinatorMs: diagnostics?.coordinatorMs ?? null,
      unclassifiedMs: diagnostics ? Math.max(0, wallAgeMs - diagnostics.coordinatorMs) : null,
      operations: diagnostics?.operations ?? null,
    },
  };
}

function missingReviewPages(presentation) {
  if (!presentation) return [];

  if (!Number.isSafeInteger(presentation.count) || presentation.count < 1
    || !Array.isArray(presentation.deliveredPages)
    || presentation.deliveredPages.some(index => !Number.isSafeInteger(index) || index < 0 || index >= presentation.count)) {
    throw new Error("semantic review page presentation state is invalid");
  }

  const delivered = new Set(presentation.deliveredPages);
  const missing = [];
  for (let index = 0; index < presentation.count; index += 1) {
    if (!delivered.has(index)) missing.push(index);
  }
  return missing;
}

function normalizedAssessment(assessment, payload, { checkpoint = false } = {}) {
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) {
    throw new Error("assessment must be an object");
  }
  if (assessment.requestId !== payload.requestId) throw new Error("assessment requestId does not match the current request");
  if (!STATUSES.has(assessment.status)) throw new Error("assessment status must be PASS, FAIL, or BLOCKED");
  const summary = validText(assessment.summary, "summary");
  const rationale = validText(assessment.rationale, "rationale");
  const nextCheck = validText(assessment.nextCheck, "nextCheck", { optional: true });
  const citations = assessment.citations === undefined ? [] : assessment.citations;
  if (!Array.isArray(citations)) throw new Error("citations must be an array");
  if (citations.length > 20) throw new Error("citations must not exceed 20 evidence locations");
  if (assessment.status === "PASS" || assessment.status === "FAIL") {
    if (payload.missingContext.length) throw new Error(`required context is unavailable: ${payload.missingContext.join("; ")}`);
    const validatedCitations = validateSemanticCitations(citations, payload.context);
    if (!checkpoint && !validatedCitations.some(citation => payload.scope.changedPaths.includes(citation.path))) {
      throw new Error("PASS and FAIL citations must include a path in the current changed scope");
    }
    if (!checkpoint && payload.context.callerContextPaths.length
      && !validatedCitations.some(citation => payload.context.callerContextPaths.includes(citation.path))) {
      throw new Error("PASS and FAIL assessments using explicit caller context must cite its captured caller or runtime source");
    }
    const findings = validateFindings(assessment, payload.scope, validatedCitations);
    return {
      status: assessment.status,
      summary,
      rationale,
      nextCheck,
      citations: validatedCitations,
      findings,
    };
  }
  const validatedCitations = citations.length ? validateSemanticCitations(citations, payload.context) : [];
  validateFindings(assessment, payload.scope, validatedCitations);
  return {
    status: assessment.status,
    summary,
    rationale,
    nextCheck,
    citations: validatedCitations,
  };
}

function resultFromAssessment(payload, assessment) {
  const citationEvidence = assessment.citations.map(citation =>
    `${citation.path}:${citation.line}${citation.state === "deleted" ? " (deleted)" : ""}: ${JSON.stringify(citation.quote)}`,
  );
  const scope = verificationScope(payload.scope.repositoryRoot, payload.scope.changedPaths, payload.scope.automatic?.delivery, "semantic-findings");
  return {
    id: payload.check.id,
    status: assessment.status,
    summary: assessment.summary,
    evidence: [assessment.rationale, ...citationEvidence].join("\n"),
    scope,
    ...(assessment.findings?.length ? { findings: assessment.findings } : {}),
    ...(assessment.nextCheck ? { nextCheck: assessment.nextCheck } : {}),
    standard: {
      id: payload.standard.id,
      source: payload.standard.source,
      gold: payload.standard.gold,
    },
    evaluation: { mode: "agentic", requestId: payload.requestId },
  };
}

export async function completeSemanticEvaluation({ cwd, requestPath, assessment }) {
  let target;
  try {
    target = await loadRequestForOperation({ cwd, requestPath });
  } catch (error) {
    if (error instanceof InvalidSemanticRequestFilename) {
      throw error;
    }

    return requestBlock(undefined, error.message);
  }

  try {
    return await withCheckLock(target.cacheDirectory, target.checkId, async () => {
      const { result: reconciled, stored, currentState } = await reconcileRequest(target);
      if (reconciled) return reconciled;
      const batchIndex = assessment?.batchIndex;
      const presentation = batchIndex === undefined
        ? currentState.pagePresentation
        : currentState.batchPagePresentations?.[batchIndex];
      const missingPages = missingReviewPages(presentation);
      if (missingPages.length > 0) {
        return {
          ...requestEnvelope(stored.payload, target.absoluteRequestPath, currentState, batchIndex),
          reviewProgress: {
            nextPage: missingPages[0],
            missingPages,
          },
        };
      }

      if (!stored.payload.continuation && stored.payload.missingContext.length
        && (assessment?.status === "PASS" || assessment?.status === "FAIL")) {
        const { context, standard } = stored.payload;
        const recoverablePaths = new Set(context.changedCode
          .filter(record => record.rangeRecovery)
          .map(record => record.path));
        const nonCallerRequirements = standard.requiredContext.filter(required => required !== "callers");

        // Range recovery permits another capture attempt, not a source verdict.
        // Keep capacity failures and every other required-evidence guard intact.
        const otherMissingContext = semanticContextMissing(nonCallerRequirements, {
          context: {
            ...context,
            missingChangedPaths: context.missingChangedPaths.filter(path => !recoverablePaths.has(path)),
          },
        });

        if (otherMissingContext.length === 0) {
          return requestEnvelope(stored.payload, target.absoluteRequestPath);
        }
      }

      let result;
      try {
        validateContinuationAssessment(assessment, stored.payload, currentState);
        const assessmentPayload = continuationAssessmentPayload(stored.payload, batchIndex);
        result = normalizedAssessment(assessment, assessmentPayload, {
          checkpoint: batchIndex !== undefined,
        });
      } catch (error) {
        const invalid = blocked(target.checkId, "Semantic assessment is invalid", error.message);
        return {
          ...invalid,
          evaluation: {
            mode: "agentic",
            requestId: stored.payload.requestId,
          },
          nextCheck: "Read the current request with review, recover any missing context, and correct the assessment using its requestId and exact captured source lines. Resubmit with evaluate; this rejected assessment has not consumed the request.",
        };
      }
      if (batchIndex !== undefined) {
        const checkpoint = { ...result, crossBatchNotes: assessment.crossBatchNotes };
        const nextState = {
          ...currentState,
          batchAssessments: { ...currentState.batchAssessments, [batchIndex]: checkpoint },
        };
        // The aggregate ledger changed. Its old receipts cannot acknowledge the new one.
        delete nextState.pagePresentation;
        const pending = requestEnvelope(stored.payload, target.absoluteRequestPath, nextState);
        await atomicWrite(statePath(target.cacheDirectory, target.checkId), JSON.stringify(nextState));
        return pending;
      }
      const finalResult = resultFromAssessment(stored.payload, result);
      if (stored.payload.continuation) {
        const batches = stored.payload.continuation.batches.map((batch, index) => ({
          index,
          contextFingerprint: batch.context.fingerprint,
          status: currentState.batchAssessments?.[index]?.status ?? "PENDING",
        }));
        finalResult.evaluation.continuation = { fingerprint: stored.payload.continuation.fingerprint, batches };
        for (const batch of batches) {
          if (batch.status !== "FAIL" && batch.status !== "BLOCKED") continue;
          const checkpoint = resultFromAssessment(stored.payload, currentState.batchAssessments[batch.index]);
          for (const finding of checkpoint.findings ?? []) {
            finalResult.findings ??= [];
            if (!finalResult.findings.some(existing => isDeepStrictEqual(existing, finding))) {
              finalResult.findings.push(finding);
            }
          }
          finalResult.evidence += `\nBatch ${batch.index} ${checkpoint.status}: ${checkpoint.summary}\n${checkpoint.evidence}`;
          if (checkpoint.nextCheck) finalResult.evidence += `\nNext check: ${checkpoint.nextCheck}`;
        }
      }
      await atomicWrite(statePath(target.cacheDirectory, target.checkId), JSON.stringify({
        ...currentState,
        consumed: true,
        finalResult,
      }));
      return finalResult;
    });
  } catch (error) {
    return requestBlock(target.checkId, error.message);
  }
}
