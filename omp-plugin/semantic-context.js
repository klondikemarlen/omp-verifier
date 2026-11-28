import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { pinnedExternalSource, readExternalText } from "#root/omp-plugin/external-context.js";
import { SemanticEvidenceBudget, sourceEvidenceRecord } from "#root/omp-plugin/semantic-evidence-budget.js";
import { captureProjectGuidance, selectBindingGuidance } from "#root/omp-plugin/semantic-guidance-evidence.js";
import { captureNearbyEvidence } from "#root/omp-plugin/semantic-nearby-evidence.js";
import {
  MAX_FILE_EVIDENCE_BYTES,
  MAX_INVENTORY_FILE_BYTES,
  normalizedProjectPath,
  readDeliveryProjectText,
  readProjectText,
} from "#root/omp-plugin/semantic-project-source.js";
import { captureChangedSource, MAX_TARGETED_RANGE_BYTES, validateSourceRecovery } from "#root/omp-plugin/semantic-required-source.js";
import { discoverSourceCandidates } from "#root/omp-plugin/semantic-source-candidates.js";
import { deliveryGuidance, inventoryProjectSource, readUnavailableSourceStates } from "#root/omp-plugin/semantic-source-inventory.js";

const DEFAULT_MAX_SOURCE_BYTES = MAX_FILE_EVIDENCE_BYTES;
const MAX_SOURCE_BYTES = MAX_INVENTORY_FILE_BYTES;
const DEFAULT_MAX_CONTEXT_PATHS = 30;
const MAX_CONTEXT_PATHS = 256;

export async function captureSemanticContext({
  repositoryRoot,
  changedPaths,
  contextPaths = [],
  callerContextPaths = [],
  externalContextPaths = [],
  externalSnapshot,
  previousContext,
  maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
  maxContextPaths,
  sourceRecovery,
  delivery,
  legacyRequest = false,
  boundedBatch = false,
  continuationBundle = false,
}) {
  const sourceByteLimit = validateSourceByteLimit(maxSourceBytes);
  const contextPathLimit = validateContextPathLimit(maxContextPaths);
  if (typeof boundedBatch !== "boolean") {
    throw new TypeError("boundedBatch must be a boolean");
  }
  if (typeof continuationBundle !== "boolean" || (continuationBundle && !boundedBatch)) {
    throw new TypeError("continuationBundle requires bounded continuation capture");
  }

  const deliveryScoped = Boolean(delivery);
  const recovery = validateSourceRecovery(sourceRecovery);
  const requiredSourceLimit = recovery?.maxSourceBytes ?? sourceByteLimit;
  const root = await realpath(repositoryRoot);
  const { normalizedChangedPaths, normalizedContextPaths, callerSourcePaths, requestedContext, externalSelectors } = selectContextPaths({
    changedPaths,
    contextPaths,
    callerContextPaths,
    externalContextPaths,
    contextPathLimit,
  });

  let inventory;
  if (deliveryScoped) {
    const deliveryPaths = new Set(delivery.changedPaths);
    const outsideDelivery = normalizedChangedPaths.find(path => !deliveryPaths.has(path));
    if (outsideDelivery !== undefined) {
      throw new Error(`changed source is outside the current delivery: ${outsideDelivery}`);
    }
    inventory = await deliveryGuidance(root, normalizedChangedPaths, normalizedContextPaths);
  } else {
    inventory = await inventoryProjectSource(root, {
      changedPaths: normalizedChangedPaths,
      contextPaths: normalizedContextPaths,
      requiredSourceLimit,
    });
  }
  const { bindingGuidancePaths, deferredGuides } = selectBindingGuidance(inventory, {
    changedPaths: normalizedChangedPaths,
    selectedPaths: normalizedContextPaths,
    delivery,
    legacyRequest,
  });
  const requiredEvidencePaths = new Set([
    ...normalizedChangedPaths,
    ...normalizedContextPaths,
    ...bindingGuidancePaths,
    ...externalSelectors.map(source => source.url),
  ]);
  const budget = new SemanticEvidenceBudget({
    requiredFiles: requiredEvidencePaths.size,
    boundedBatch,
    continuationBundle,
  });

  const { changedCode, changedCodeCoverage, missingChangedPaths, recoveredSelectorPaths } = await captureChangedSource(root, {
    changedPaths: normalizedChangedPaths,
    requestedContext,
    previousContext,
    deletedSources: inventory.deletedSources,
    sourceByteLimit,
    recovery,
    delivery,
    legacyRequest,
  }, budget);
  const { targetedContext, missingContextPaths } = await captureTargetedContext(root, {
    requestedContext,
    recoveredSelectorPaths,
    callerSourcePaths,
    deliveryScoped,
  }, budget);

  const { projectGuidance, deferredGuidance, guidanceRequirements, missingGuidancePaths } = await captureProjectGuidance(root, {
    bindingGuidancePaths,
    deferredGuides,
    boundaryPaths: inventory.boundaryPaths,
    changedCode,
    missingChangedPaths,
    targetedContext,
    requestedContext,
    recovery,
    deliveryScoped,
  }, budget);
  const externalContext = await captureExternalContext(externalSelectors, externalSnapshot, boundedBatch, budget);
  const nearbyEvidence = deliveryScoped
    ? deliveryEvidence(normalizedChangedPaths, normalizedContextPaths)
    : captureNearbyEvidence(discoverSourceCandidates({
      changedPaths: normalizedChangedPaths,
      selectedInventoryPaths: inventory.selectedPaths,
      availableText: inventory.availableText,
    }), inventory, { changedCode, targetedContext }, budget);

  const { callers, siblings, siblingInventory, sourceInventory, callerInventory, evidenceTruncated } = nearbyEvidence;
  const context = {
    changedPaths: normalizedChangedPaths,
    ...(recovery ? { sourceRecovery: recovery } : {}),
    changedCode,
    ...(changedCodeCoverage.length ? { changedCodeCoverage } : {}),
    callers,
    siblings,
    siblingInventory,
    projectGuidance,
    ...(deferredGuidance ? { deferredGuidance } : {}),
    guidanceRequirements,
    targetedContext,
    ...(externalContext.length ? { externalContext } : {}),
    sourceInventory,
    callerContextPaths: [...callerSourcePaths].sort(),
    callerRetrieval: {
      ...callerInventory,
      recovery: deliveryScoped
        ? "Do not search outside the delivery for candidates. If the user explicitly authorizes more evidence, use review --context, --caller-context or --external-context with only the named selectors. If an unresolved relationship materially prevents assessment, name the missing prerequisite and report BLOCKED; absence here does not establish global caller completeness."
        : "Use review --context for material source callers, or --caller-context for real runner configuration/discovery source. Assess runtime applicability from captured source; this does not establish global caller completeness.",
    },
    evidenceBudget: budget.snapshot({
      maxSourceBytes: sourceByteLimit,
      maxContextPaths: maxContextPaths === undefined ? undefined : contextPathLimit,
    }),
    evidenceTruncated,
    notes: [
      ...(budget.truncated ? ["Some context evidence was omitted within the bounded evidence-size or file-count limit; request material files or ranges explicitly."] : []),
      ...(!sourceInventory.complete ? ["Source inventory is incomplete; callers or siblings may be omitted."] : []),
    ],
    missingChangedPaths,
    missingContextPaths,
    missingGuidancePaths,
  };
  if (boundedBatch) {
    const unavailablePaths = [...new Set([...missingChangedPaths, ...missingContextPaths, ...missingGuidancePaths])].sort();
    context.unavailableSourceStates = await readUnavailableSourceStates(root, unavailablePaths);
  }
  context.fingerprint = contextFingerprint(context, !legacyRequest);
  return { context, fingerprint: context.fingerprint };
}

function deliveryEvidence(changedPaths, contextPaths) {
  return {
    callers: {
      status: "not-searched",
      explanation: "Assess any applicable caller relationships from the captured changed source and named context. No repository-wide caller search was performed.",
    },
    siblings: {
      status: "not-searched",
      explanation: "Assess neighboring source only when captured as changed source or named context. Directories were not enumerated for siblings.",
    },
    siblingInventory: [],
    sourceInventory: {
      scope: "delivery",
      complete: true,
      files: [...new Set([...changedPaths, ...contextPaths])].sort(),
      note: "Only the named source paths in this request were considered; this is not a repository inventory. Governing guidance is listed separately.",
    },
    callerInventory: { scope: "delivery" },
    evidenceTruncated: { callers: false, siblings: false },
  };
}

function selectContextPaths({ changedPaths, contextPaths, callerContextPaths, externalContextPaths, contextPathLimit }) {
  const normalizedChangedPaths = [...new Set(changedPaths.map(path => normalizedProjectPath(path, "changed path")))].sort();
  const callerSourcePaths = new Set(callerContextPaths.map(contextRange).map(context =>
    normalizedProjectPath(context.path, "caller context path")));
  if ([...callerSourcePaths].some(path => normalizedChangedPaths.includes(path))) {
    throw new Error("caller context must identify separate caller or runtime discovery source, not the changed file itself");
  }
  const selectors = [...new Set([...contextPaths, ...callerContextPaths])].map(contextRange).map(context => ({
    ...context,
    path: normalizedProjectPath(context.path, "context path"),
  }));
  const externalSelectors = [...new Set(externalContextPaths)].map(selector => {
    const range = contextRange(selector);
    return { selector, ...range, ...pinnedExternalSource(range.path) };
  });
  if (selectors.length + externalSelectors.length > contextPathLimit) {
    const nextAction = contextPathLimit < MAX_CONTEXT_PATHS
      ? `renew with review --max-context-paths <${contextPathLimit + 1}-${MAX_CONTEXT_PATHS}> to select a larger request-local allowance`
      : "recover the same required evidence with fewer selectors; no larger selector allowance is supported";
    throw new Error(`local and external context must not exceed ${contextPathLimit} selectors; ${nextAction}, within unchanged source/file/byte limits`);
  }
  const requestedContext = selectors.filter(context =>
    context.startLine || !selectors.some(other => other.path === context.path && other.startLine));
  const normalizedContextPaths = [...new Set(requestedContext.map(context => context.path))].sort();
  return { normalizedChangedPaths, normalizedContextPaths, callerSourcePaths, requestedContext, externalSelectors };
}

async function captureTargetedContext(root, { requestedContext, recoveredSelectorPaths, callerSourcePaths, deliveryScoped }, budget) {
  const readText = deliveryScoped ? readDeliveryProjectText : readProjectText;
  const targetedContext = [];
  const missingContextPaths = [];
  for (const selector of requestedContext) {
    const { path } = selector;
    if (recoveredSelectorPaths.has(path)) continue;

    const range = selector.startLine ? selector : undefined;
    const result = await readText(root, path, MAX_FILE_EVIDENCE_BYTES, range, MAX_TARGETED_RANGE_BYTES);
    if (result.missing || result.error) {
      targetedContext.push({ path, state: "unavailable", reason: result.error ?? "path is absent" });
      missingContextPaths.push(path);
      continue;
    }
    const source = callerSourcePaths.has(path) ? "caller-context" : "targeted-context";
    if (!budget.admit(targetedContext, sourceEvidenceRecord(path, result, source))) {
      targetedContext.push({ path, state: "unavailable", reason: "context evidence limit reached" });
      missingContextPaths.push(path);
    }
  }
  return { targetedContext, missingContextPaths };
}

async function captureExternalContext(externalSelectors, externalSnapshot, boundedBatch, budget) {
  const externalContext = [];
  for (const source of externalSelectors) {
    // Stored requests are integrity-checked before reuse. Immutable remote snapshots
    // need no network access during page reads or final local-source freshness checks.
    const snapshot = externalSnapshot?.find(record => record.selector === source.selector);
    let record = snapshot;
    if (boundedBatch && snapshot?.state === "unavailable" && snapshot.reason === "context evidence limit reached") {
      record = undefined;
    }
    if (!record) {
      const result = await readExternalText(source, source.startLine ? source : undefined);
      const identity = { path: source.url, selector: source.selector, revision: source.revision, source: "external-context" };
      record = result.error
        ? { ...identity, state: "unavailable", reason: result.error }
        : { ...sourceEvidenceRecord(source.url, result, "external-context"), ...identity };
    }
    if (record.state === "unavailable") {
      externalContext.push(record);
    } else if (!budget.admit(externalContext, record)) {
      externalContext.push({
        path: source.url,
        selector: source.selector,
        revision: source.revision,
        source: "external-context",
        state: "unavailable",
        reason: "context evidence limit reached",
      });
    }
  }
  return externalContext;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateSourceByteLimit(value = DEFAULT_MAX_SOURCE_BYTES) {
  if (!Number.isSafeInteger(value) || value < DEFAULT_MAX_SOURCE_BYTES || value > MAX_SOURCE_BYTES) {
    throw new RangeError(`maxSourceBytes must be a safe integer from ${DEFAULT_MAX_SOURCE_BYTES} through ${MAX_SOURCE_BYTES}`);
  }
  return value;
}

export function validateContextPathLimit(value = DEFAULT_MAX_CONTEXT_PATHS) {
  if (!Number.isSafeInteger(value) || value < DEFAULT_MAX_CONTEXT_PATHS || value > MAX_CONTEXT_PATHS) {
    throw new RangeError(`maxContextPaths must be a safe integer from ${DEFAULT_MAX_CONTEXT_PATHS} through ${MAX_CONTEXT_PATHS}`);
  }
  return value;
}

function contextRange(value) {
  const match = /^(.*)#L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(value);
  if (!match) return { path: value };
  const startLine = Number(match[2]);
  const endLine = Number(match[3] ?? match[2]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || endLine < startLine || endLine - startLine >= 500) {
    throw new Error("context line ranges must be ordered and contain at most 500 lines");
  }
  return { path: match[1], startLine, endLine };
}

function contextFingerprint(context, includeMaxSourceBytes = true) {
  const fingerprint = {
    changedPaths: context.changedPaths,
    changedCode: context.changedCode,
    changedCodeCoverage: context.changedCodeCoverage,
    callers: context.callers,
    siblings: context.siblings,
    siblingInventory: context.siblingInventory,
    projectGuidance: context.projectGuidance,
    targetedContext: context.targetedContext,
    sourceInventory: context.sourceInventory,
    callerContextPaths: context.callerContextPaths,
  };
  if (context.externalContext?.length) fingerprint.externalContext = context.externalContext;
  if (context.deferredGuidance) fingerprint.deferredGuidance = context.deferredGuidance;
  if (includeMaxSourceBytes) fingerprint.maxSourceBytes = context.evidenceBudget.maxSourceBytes;
  if (context.evidenceBudget.maxContextPaths !== undefined) {
    fingerprint.maxContextPaths = context.evidenceBudget.maxContextPaths;
  }
  if (context.sourceRecovery) fingerprint.sourceRecovery = context.sourceRecovery;
  if (context.sourceInventory.scope === "delivery" && !context.evidenceBudget.boundedBatch) {
    fingerprint.guidanceRequirements = context.guidanceRequirements;
    fingerprint.missingGuidancePaths = context.missingGuidancePaths;
  }
  if (context.evidenceBudget.boundedBatch) {
    fingerprint.evidenceBudget = context.evidenceBudget;
    fingerprint.guidanceRequirements = context.guidanceRequirements;
    fingerprint.missingChangedPaths = context.missingChangedPaths;
    fingerprint.missingContextPaths = context.missingContextPaths;
    fingerprint.missingGuidancePaths = context.missingGuidancePaths;
    fingerprint.unavailableSourceStates = context.unavailableSourceStates;
  }
  return sha256(JSON.stringify(fingerprint));
}
