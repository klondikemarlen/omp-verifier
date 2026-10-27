import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { loadSemanticContract } from "#root/omp-plugin/semantic-contracts.js";
import {
  captureSemanticContext,
  semanticContextMissing,
  validateSemanticCitations,
} from "#root/omp-plugin/semantic-context.js";

const execFileAsync = promisify(execFile);
const CACHE_DIRECTORY = resolve(tmpdir(), `omp-verifier-semantic-${process.getuid?.() ?? "user"}`);
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const MAX_ASSESSMENT_LENGTH = 4_000;
const LOCK_WAIT_MS = 15_000;

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

function checkIdFromRequestPath(requestPath) {
  const match = basename(requestPath).match(/^([A-Za-z0-9_-]+)\.([0-9a-f-]{36})\.json$/);
  if (!match) throw new Error("request path does not identify a semantic evaluation request");
  const checkId = Buffer.from(match[1], "base64url").toString("utf8");
  if (!/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(checkId)) {
    throw new Error("request path has an invalid check identity");
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
  const startedAt = Date.now();
  let lockHandle;
  while (!lockHandle) {
    let candidateHandle;
    try {
      candidateHandle = await open(filePath, "wx", 0o600);
      await candidateHandle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      lockHandle = candidateHandle;
    } catch (error) {
      if (candidateHandle) {
        await candidateHandle.close();
        await rm(filePath, { force: true });
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() - startedAt > LOCK_WAIT_MS) {
        throw new Error(`semantic request state is busy: ${filePath}; finish its owner operation, or remove an abandoned lock only after confirming its recorded owner process has exited`);
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
  }

  try {
    return await callback();
  } finally {
    await lockHandle.close();
    await rm(filePath, { force: true });
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
  await pruneDirectory(requestsDirectory, MAX_CACHED_REQUESTS);
  await pruneDirectory(statesDirectory, MAX_CACHED_CHECKS);
  return cacheDirectory;
}

async function readCurrentState(cacheDirectory, checkId) {
  try {
    return JSON.parse(await readFile(statePath(cacheDirectory, checkId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`could not read semantic request state: ${error.message}`);
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
    throw new Error(`semantic request file is unavailable: ${error.message}`);
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

async function previousPayload(cacheDirectory, checkId) {
  const currentState = await readCurrentState(cacheDirectory, checkId);
  if (!currentState?.requestId) return undefined;
  try {
    return (await readStoredRequest(cacheDirectory, checkId, currentState.requestId, { requireCurrent: false })).stored.payload;
  } catch {
    return undefined;
  }
}

async function currentDefinition(check) {
  let manifestContents;
  try {
    manifestContents = await readFile(check.manifestPath, "utf8");
  } catch (error) {
    throw new Error(`plugin manifest is unavailable: ${error.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestContents);
  } catch (error) {
    throw new Error(`plugin manifest is not valid JSON: ${error.message}`);
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


async function captureRequest({ check, repositoryRoot, changedPaths, contextPaths, callerContextPaths = [], previousContext }) {
  const definition = await currentDefinition(check);
  const captured = await captureSemanticContext({
    repositoryRoot,
    changedPaths,
    contextPaths,
    callerContextPaths,
    previousContext,
  });
  const missingContext = semanticContextMissing(definition.contract.requiredContext, captured);
  const requestId = randomUUID();
  const payload = {
    version: 1,
    requestId,
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
      contextPaths: [...contextPaths],
      callerContextPaths: [...callerContextPaths],
    },
    context: captured.context,
    missingContext,
  };
  const stored = {
    payload,
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

function requestEnvelope(payload, requestPath) {
  let summary = "Semantic evaluation is ready for assessment";
  if (payload.missingContext.length) {
    summary = "Semantic evaluation awaits required context";
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
    previousContext: payload.context,
  });
  if (captured.fingerprint !== runtime.contextFingerprint || captured.fingerprint !== payload.context.fingerprint) {
    throw new Error("captured source or project context changed after the request was prepared");
  }
}

function requestBlock(id, error) {
  return blocked(id || "semantic-evaluation", "Semantic request is unavailable", error);
}

async function reconcileSupersededRequest(target) {
  const currentState = await readCurrentState(target.cacheDirectory, target.checkId);
  if (!currentState || currentState.requestId === target.requestId) return undefined;

  const current = await readStoredRequest(target.cacheDirectory, target.checkId, currentState.requestId, {
    requireCurrent: false,
  });
  await validateFreshness({
    checkId: target.checkId,
    repositoryRoot: target.repositoryRoot,
    stored: current.stored,
  });
  const evaluation = {
    mode: "agentic",
    requestId: target.requestId,
    supersededBy: currentState.requestId,
  };
  if (currentState.consumed) {
    return {
      id: target.checkId,
      status: "SUPERSEDED",
      summary: "Obsolete semantic operation skipped; the current request has already been assessed",
      evaluation,
    };
  }

  return {
    ...requestEnvelope(current.stored.payload, current.requestPath),
    evaluation,
  };
}

export async function prepareSemanticEvaluation({ check, cwd, changedPaths = [], repositoryRoot = cwd, contextPaths = [] }) {
  if (!check || check.mode !== "agentic" || !check.manifestPath || !check.packagePath) {
    return blocked(check?.id || "semantic-evaluation", "Semantic verification check is not supported by this runtime");
  }

  try {
    const root = await realpath(repositoryRoot);
    const cacheDirectory = await requestCacheRoot(root);
    return await withCheckLock(cacheDirectory, check.id, async () => {
      const previous = await previousPayload(cacheDirectory, check.id);
      const result = await captureRequest({
        check,
        repositoryRoot: root,
        changedPaths,
        contextPaths,
        previousContext: previous?.context,
      });
      const requestPath = join(cacheDirectory, "requests", requestFileName(check.id, result.requestId));
      await persistRequest(cacheDirectory, check.id, requestPath, result.stored);
      return requestEnvelope(result.payload, requestPath);
    });
  } catch (error) {
    return requestBlock(check.id, error.message);
  }
}

export async function readSemanticEvaluation({ cwd, requestPath, contextPaths = [], callerContextPaths = [] }) {
  let target;
  try {
    target = await loadRequestForOperation({ cwd, requestPath });
  } catch (error) {
    return requestBlock(undefined, error.message);
  }

  try {
    return await withCheckLock(target.cacheDirectory, target.checkId, async () => {
      const superseded = await reconcileSupersededRequest(target);
      if (superseded) return superseded;

      const { stored } = await readStoredRequest(target.cacheDirectory, target.checkId, target.requestId);
      await validateFreshness({ checkId: target.checkId, repositoryRoot: target.repositoryRoot, stored });

      if (!Array.isArray(contextPaths)) throw new Error("contextPaths must be an array of project-relative paths");
      if (!Array.isArray(callerContextPaths)) throw new Error("callerContextPaths must be an array of project-relative paths");
      const additionalContextPaths = [...new Set([...stored.payload.scope.contextPaths, ...contextPaths])];
      const previousCallerContext = stored.payload.scope.callerContextPaths ?? [];
      const additionalCallerContext = [...new Set([...previousCallerContext, ...callerContextPaths])];
      const hasAdditionalContext = additionalContextPaths.length !== stored.payload.scope.contextPaths.length
        || additionalCallerContext.length !== previousCallerContext.length;
      if (!hasAdditionalContext) return requestEnvelope(stored.payload, target.absoluteRequestPath);

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
        previousContext: stored.payload.context,
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
    const { currentState } = await readStoredRequest(target.cacheDirectory, target.checkId, target.requestId);
    const previous = currentState.pagePresentation;
    let deliveredPages = [];
    if (previous?.viewFingerprint === page.viewFingerprint && previous.count === page.count) {
      deliveredPages = previous.deliveredPages;
    }

    const delivered = new Set(deliveredPages);
    delivered.add(page.index);
    await atomicWrite(statePath(target.cacheDirectory, target.checkId), JSON.stringify({
      ...currentState,
      pagePresentation: {
        viewFingerprint: page.viewFingerprint,
        count: page.count,
        deliveredPages: [...delivered].sort((left, right) => left - right),
      },
    }));
  });
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

function normalizedAssessment(assessment, payload) {
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
    if (!validatedCitations.some(citation => payload.scope.changedPaths.includes(citation.path))) {
      throw new Error("PASS and FAIL citations must include a path in the current changed scope");
    }
    if (payload.context.callerContextPaths.length
      && !validatedCitations.some(citation => payload.context.callerContextPaths.includes(citation.path))) {
      throw new Error("PASS and FAIL assessments using explicit caller context must cite its captured caller or runtime source");
    }
    return { status: assessment.status, summary, rationale, nextCheck, citations: validatedCitations };
  }
  const validatedCitations = citations.length ? validateSemanticCitations(citations, payload.context) : [];
  return { status: assessment.status, summary, rationale, nextCheck, citations: validatedCitations };
}

function resultFromAssessment(payload, assessment) {
  const citationEvidence = assessment.citations.map(citation =>
    `${citation.path}:${citation.line}${citation.state === "deleted" ? " (deleted)" : ""}: ${JSON.stringify(citation.quote)}`,
  );
  return {
    id: payload.check.id,
    status: assessment.status,
    summary: assessment.summary,
    evidence: [assessment.rationale, ...citationEvidence].join("\n"),
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
    return requestBlock(undefined, error.message);
  }

  try {
    return await withCheckLock(target.cacheDirectory, target.checkId, async () => {
      const superseded = await reconcileSupersededRequest(target);
      if (superseded) return superseded;

      const { stored, currentState } = await readStoredRequest(target.cacheDirectory, target.checkId, target.requestId);
      await validateFreshness({
        checkId: target.checkId,
        repositoryRoot: target.repositoryRoot,
        stored,
      });
      const missingPages = missingReviewPages(currentState.pagePresentation);
      if (missingPages.length > 0) {
        return {
          ...requestEnvelope(stored.payload, target.absoluteRequestPath),
          reviewProgress: {
            nextPage: missingPages[0],
            missingPages,
          },
        };
      }

      const result = normalizedAssessment(assessment, stored.payload);
      if (result.status === "FAIL" && !result.citations.length) {
        throw new Error("FAIL assessments require an actual source location citation");
      }
      const finalResult = resultFromAssessment(stored.payload, result);
      await atomicWrite(statePath(target.cacheDirectory, target.checkId), JSON.stringify({
        ...currentState,
        consumed: true,
      }));
      return finalResult;
    });
  } catch (error) {
    return requestBlock(target.checkId, error.message);
  }
}
