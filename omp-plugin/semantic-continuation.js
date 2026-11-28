import { createHash } from "node:crypto";

import { captureSemanticContext } from "#root/omp-plugin/semantic-context.js";
import { semanticContextMissing } from "#root/omp-plugin/semantic-context-missing.js";

const LIMITS = Object.freeze({ maxBatchBytes: 256_000, maxBatchFiles: 256, maxBatches: 32 });
const SOURCE_GROUPS = ["changedCode", "projectGuidance", "targetedContext", "externalContext", "callers", "siblings"];

function requiredCapacityRejections(context) {
  return context.evidenceBudget.rejections.filter(record => record.source !== "callers" && record.source !== "siblings");
}

function continuationFingerprint(options, requiredContext, batches, captures) {
  const scope = {
    repositoryRoot: options.repositoryRoot,
    changedPaths: captures.flatMap(capture => capture.changedPaths),
    contextPaths: options.contextPaths ?? [],
    callerContextPaths: options.callerContextPaths ?? [],
    externalContextPaths: options.externalContextPaths ?? [],
    maxSourceBytes: options.maxSourceBytes ?? batches[0].context.evidenceBudget.maxSourceBytes,
    maxContextPaths: options.maxContextPaths,
    sourceRecovery: options.sourceRecovery ? {
      chunkBytes: options.sourceRecovery.chunkBytes,
      maxSourceBytes: options.sourceRecovery.maxSourceBytes,
      modelContext: options.sourceRecovery.modelContext,
    } : undefined,
    automatic: options.automaticScope ?? options.automatic,
  };
  return createHash("sha256").update(JSON.stringify({
    version: 2,
    limits: LIMITS,
    scope,
    requiredContext,
    captures,
    batches: batches.map(batch => ({
      captureIndex: batch.captureIndex,
      changedPaths: batch.changedPaths,
      context: batch.context,
      missingContext: batch.missingContext,
    })),
  })).digest("hex");
}

function capacityPrerequisite(context, rejections) {
  const { changedPaths } = context;
  const details = rejections.map(record => `${record.path} (${record.source}: ${record.reason})`).join("; ");
  const recovery = context.deliveryIdentity
    ? "Do not widen or fragment the review."
    : "Recover bounded material context selectors while preserving complete changed-source coverage and applicable guidance.";
  return new Error(`Bounded continuation cannot capture the required bundle for ${changedPaths.join(", ") || "the empty changed scope"} within ${LIMITS.maxBatches} batches of ${LIMITS.maxBatchBytes} bytes / ${LIMITS.maxBatchFiles} paths. ${details}. ${recovery} Keep the whole review BLOCKED until the required evidence fits.`);
}

function partitionEvidence(context) {
  const partitions = [];
  let records = [];
  let paths = new Set();
  let bytes = 0;
  for (const group of SOURCE_GROUPS) {
    if (!Array.isArray(context[group])) continue;
    for (const record of context[group]) {
      if (typeof record.content !== "string") continue;
      const recordBytes = Buffer.byteLength(record.content);
      if (recordBytes > LIMITS.maxBatchBytes) {
        throw capacityPrerequisite(context, [{
          path: record.path,
          source: record.source,
          reason: "one evidence record exceeds the batch byte limit",
        }]);
      }
      if (records.length && (bytes + recordBytes > LIMITS.maxBatchBytes
        || (!paths.has(record.path) && paths.size >= LIMITS.maxBatchFiles))) {
        partitions.push(records);
        records = [];
        paths = new Set();
        bytes = 0;
      }
      records.push({
        group,
        record,
      });
      paths.add(record.path);
      bytes += recordBytes;
    }
  }
  if (records.length || !partitions.length) partitions.push(records);
  return partitions.map(partition => {
    const selected = {
      ...context,
    };
    for (const group of SOURCE_GROUPS) {
      if (!Array.isArray(context[group])) continue;
      const unavailableRecords = context[group].filter(record => typeof record.content !== "string");
      const partitionRecords = partition.filter(entry => entry.group === group).map(entry => entry.record);
      selected[group] = [
        ...unavailableRecords,
        ...partitionRecords,
      ];
    }
    const admittedRecords = partition.map(({ record }) => {
      const bytes = Buffer.byteLength(record.content);
      const startLine = record.startLine ?? 1;
      return {
        path: record.path,
        source: record.source,
        bytes,
        startLine,
        ...(context.deliveryIdentity && record.reference ? { state: record.state } : {}),
      };
    });
    const usedBytes = admittedRecords.reduce((total, record) => total + record.bytes, 0);
    const usedFiles = new Set(admittedRecords.map(record => record.path)).size;
    selected.evidenceBudget = {
      ...context.evidenceBudget,
      maxBytes: LIMITS.maxBatchBytes,
      maxFiles: LIMITS.maxBatchFiles,
      usedBytes,
      usedFiles,
      records: admittedRecords,
    };
    selected.notes = [
      ...context.notes,
      "This batch contains only part of one required evidence bundle. Source coverage and governing guidance span its sibling batches. Checkpoint this evidence and preserve unresolved relationships in crossBatchNotes; only the final whole-scope assessment can approve the change.",
    ];
    delete selected.fingerprint;
    selected.fingerprint = createHash("sha256").update(JSON.stringify(selected)).digest("hex");
    return selected;
  });
}

export async function captureSemanticContinuation(options, requiredContext) {
  if (!Array.isArray(requiredContext)) throw new TypeError("requiredContext must be an array");
  const delivery = (options.automaticScope ?? options.automatic)?.delivery;
  let captured = await captureSemanticContext({
    ...options,
    delivery,
    boundedBatch: true,
    legacyRequest: false,
  });
  const changedPaths = captured.context.changedPaths;
  const rejections = requiredCapacityRejections(captured.context);
  const partitioned = rejections.length > 0;
  if (partitioned) {
    // Retain successful immutable snapshots, not failed admission placeholders.
    const externalSnapshots = new Map((options.externalSnapshot ?? []).map(record => [record.selector, record]));
    const rejectedPaths = new Set(rejections.filter(record => record.source === "external-context").map(record => record.path));
    for (const record of captured.context.externalContext ?? []) {
      if (!rejectedPaths.has(record.path)) externalSnapshots.set(record.selector, record);
    }
    captured = await captureSemanticContext({
      ...options,
      delivery,
      externalSnapshot: [...externalSnapshots.values()],
      boundedBatch: true,
      continuationBundle: true,
      legacyRequest: false,
    });
    const remaining = requiredCapacityRejections(captured.context);
    if (remaining.length) throw capacityPrerequisite(captured.context, remaining);
  }
  let contexts;
  if (partitioned) {
    contexts = partitionEvidence(captured.context);
  } else {
    contexts = [captured.context];
  }
  if (contexts.length > LIMITS.maxBatches) throw capacityPrerequisite(captured.context, rejections);
  const missingContext = semanticContextMissing(requiredContext, captured);
  const captures = [{
    changedPaths,
    partitioned,
    fingerprint: captured.fingerprint,
    missingContext,
  }];
  const batches = contexts.map(context => ({
    captureIndex: 0,
    changedPaths,
    context,
    missingContext,
  }));
  return {
    version: 2,
    limits: { ...LIMITS },
    captures,
    batches,
    fingerprint: continuationFingerprint(options, requiredContext, batches, captures),
  };
}

function validatePartition(continuation, changedPaths) {
  if (!Array.isArray(changedPaths)
    || continuation?.version !== 2
    || !continuation.limits
    || Object.keys(LIMITS).some(key => continuation.limits[key] !== LIMITS[key])
    || !Array.isArray(continuation.batches)
    || !Array.isArray(continuation.captures)
    || continuation.captures.length === 0
    || continuation.batches.length === 0
    || continuation.batches.length > LIMITS.maxBatches) {
    throw new Error("bounded continuation plan identity or limits are invalid; prepare a fresh review with the complete original scope");
  }
  const partition = continuation.captures.flatMap(capture => capture.changedPaths);
  for (const batch of continuation.batches) {
    if (!Array.isArray(batch.changedPaths)
      || !Number.isSafeInteger(batch.captureIndex)
      || !continuation.captures[batch.captureIndex]
      || JSON.stringify(batch.changedPaths) !== JSON.stringify(continuation.captures[batch.captureIndex].changedPaths)
      || !batch.context
      || typeof batch.context.fingerprint !== "string"
      || !Array.isArray(batch.missingContext)
      || JSON.stringify(batch.changedPaths) !== JSON.stringify(batch.context.changedPaths)
      || (batch.changedPaths.length === 0 && changedPaths.length !== 0)
      || batch.context.evidenceBudget?.boundedBatch !== true
      || batch.context.evidenceBudget.maxBytes !== LIMITS.maxBatchBytes
      || batch.context.evidenceBudget.maxFiles !== LIMITS.maxBatchFiles
      || !Number.isSafeInteger(batch.context.evidenceBudget.usedBytes)
      || batch.context.evidenceBudget.usedBytes < 0
      || !Number.isSafeInteger(batch.context.evidenceBudget.usedFiles)
      || batch.context.evidenceBudget.usedFiles < 0
      || batch.context.evidenceBudget.usedBytes > LIMITS.maxBatchBytes
      || batch.context.evidenceBudget.usedFiles > LIMITS.maxBatchFiles
      || requiredCapacityRejections(batch.context).length) {
      throw new Error("bounded continuation batch identity or capacity is invalid; prepare a fresh review with the complete original scope");
    }
  }
  if (!Array.isArray(changedPaths)
    || partition.some(path => typeof path !== "string")
    || new Set(partition).size !== partition.length
    || JSON.stringify(partition) !== JSON.stringify([...partition].sort())
    || JSON.stringify(partition) !== JSON.stringify(changedPaths)) {
    throw new Error("bounded continuation batches no longer exactly partition the complete changed scope; prepare a fresh review");
  }
}

export async function validateSemanticContinuation(payload) {
  const { continuation, scope, standard } = payload;
  validatePartition(continuation, scope.changedPaths);
  if (!Array.isArray(standard.requiredContext)
    || continuation.fingerprint !== continuationFingerprint(scope, standard.requiredContext, continuation.batches, continuation.captures)) {
    throw new Error("bounded continuation scope or batch fingerprints changed; prepare a fresh review");
  }
  for (const [index, capture] of continuation.captures.entries()) {
    const contexts = continuation.batches.filter(batch => batch.captureIndex === index).map(batch => batch.context);
    if (!contexts.length) throw new Error("bounded continuation capture has no evidence batches; prepare a fresh review");
    const previousContext = {
      ...contexts[0],
    };
    for (const group of SOURCE_GROUPS) {
      if (Array.isArray(previousContext[group])) {
        previousContext[group] = contexts.flatMap(context => context[group] ?? []);
      }
    }
    const captured = await captureSemanticContext({
      repositoryRoot: scope.repositoryRoot,
      changedPaths: capture.changedPaths,
      contextPaths: scope.contextPaths,
      callerContextPaths: scope.callerContextPaths,
      externalContextPaths: scope.externalContextPaths,
      externalSnapshot: previousContext.externalContext,
      previousContext,
      maxSourceBytes: scope.maxSourceBytes,
      maxContextPaths: scope.maxContextPaths,
      sourceRecovery: scope.sourceRecovery,
      delivery: scope.automatic?.delivery,
      boundedBatch: true,
      continuationBundle: capture.partitioned,
    });
    if (captured.fingerprint !== capture.fingerprint
      || JSON.stringify(semanticContextMissing(standard.requiredContext, captured)) !== JSON.stringify(capture.missingContext)) {
      throw new Error(`captured source or project context changed in bounded continuation capture ${index}; prepare a fresh review and discard every prior batch checkpoint`);
    }
  }
  return true;
}
