import { createHash } from "node:crypto";
import { captureSemanticContext, semanticContextMissing } from "#root/omp-plugin/semantic-context.js";

const LIMITS = Object.freeze({ maxBatchBytes: 256_000, maxBatchFiles: 256, maxBatches: 32 });

function requiredCapacityRejections(context) {
  return context.evidenceBudget.rejections.filter(record => record.source !== "callers" && record.source !== "siblings");
}

function continuationFingerprint(options, requiredContext, batches) {
  const scope = {
    repositoryRoot: options.repositoryRoot,
    changedPaths: batches.flatMap(batch => batch.changedPaths),
    contextPaths: options.contextPaths ?? [],
    callerContextPaths: options.callerContextPaths ?? [],
    externalContextPaths: options.externalContextPaths ?? [],
    maxSourceBytes: options.maxSourceBytes ?? batches[0].context.evidenceBudget.maxSourceBytes,
    sourceRecovery: options.sourceRecovery ? {
      chunkBytes: options.sourceRecovery.chunkBytes,
      maxSourceBytes: options.sourceRecovery.maxSourceBytes,
      modelContext: options.sourceRecovery.modelContext,
    } : undefined,
    automatic: options.automaticScope ?? options.automatic,
  };
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    limits: LIMITS,
    scope,
    requiredContext,
    batches: batches.map(batch => ({
      changedPaths: batch.changedPaths,
      context: batch.context,
      missingContext: batch.missingContext,
    })),
  })).digest("hex");
}

function capacityPrerequisite(paths, rejections) {
  const details = rejections.map(record => `${record.path} (${record.source}: ${record.reason})`).join("; ");
  return new Error(`Bounded continuation cannot capture the required bundle for ${paths.join(", ") || "the empty changed scope"} within ${LIMITS.maxBatchBytes} bytes / ${LIMITS.maxBatchFiles} paths. ${details}. Recover bounded material context selectors while preserving complete changed-source coverage and applicable guidance, or supply a supported whole-source prerequisite. A single changed file cannot be split across batches; keep the whole review BLOCKED until its required bundle fits.`);
}

export async function captureSemanticContinuation(options, requiredContext) {
  if (!Array.isArray(requiredContext)) throw new TypeError("requiredContext must be an array");
  const firstCapture = await captureSemanticContext({ ...options, boundedBatch: true, legacyRequest: false });
  const changedPaths = firstCapture.context.changedPaths;
  const batches = [];
  let plannedBatches = 1;

  // Successful immutable external snapshots can be shared without refetching.
  // An admission failure is not a source snapshot: retry it in the smaller bundle.
  const externalSnapshots = new Map((options.externalSnapshot ?? []).map(record => [record.selector, record]));
  function retainExternalSnapshots(context) {
    const rejectedPaths = new Set(requiredCapacityRejections(context).filter(record => record.source === "external-context").map(record => record.path));
    for (const record of context.externalContext ?? []) {
      if (!rejectedPaths.has(record.path)) externalSnapshots.set(record.selector, record);
    }
  }

  async function capturePaths(paths, captured) {
    captured ??= await captureSemanticContext({
      ...options,
      changedPaths: paths,
      externalSnapshot: [...externalSnapshots.values()],
      boundedBatch: true,
      legacyRequest: false,
    });
    retainExternalSnapshots(captured.context);
    const rejections = requiredCapacityRejections(captured.context);
    if (rejections.length) {
      if (paths.length <= 1) throw capacityPrerequisite(paths, rejections);
      plannedBatches += 1;
      if (plannedBatches > LIMITS.maxBatches) {
        throw new Error(`Bounded continuation requires more than ${LIMITS.maxBatches} batches of ${LIMITS.maxBatchBytes} bytes / ${LIMITS.maxBatchFiles} paths. Recover required context selectors or another supported evidence prerequisite without dropping changed paths or guidance; keep the complete review BLOCKED. Last rejected records: ${rejections.map(record => `${record.path} (${record.reason})`).join("; ")}`);
      }
      const midpoint = Math.floor(paths.length / 2);
      await capturePaths(paths.slice(0, midpoint));
      await capturePaths(paths.slice(midpoint));
      return;
    }
    batches.push({
      changedPaths: [...paths],
      context: captured.context,
      missingContext: semanticContextMissing(requiredContext, captured),
    });
  }

  await capturePaths(changedPaths, firstCapture);
  return {
    version: 1,
    limits: { ...LIMITS },
    batches,
    fingerprint: continuationFingerprint(options, requiredContext, batches),
  };
}

function validatePartition(continuation, changedPaths) {
  if (!Array.isArray(changedPaths)
    || continuation?.version !== 1
    || !continuation.limits
    || Object.keys(LIMITS).some(key => continuation.limits[key] !== LIMITS[key])
    || !Array.isArray(continuation.batches)
    || continuation.batches.length === 0
    || continuation.batches.length > LIMITS.maxBatches
    || (changedPaths.length === 0 && continuation.batches.length !== 1)) {
    throw new Error("bounded continuation plan identity or limits are invalid; prepare a fresh review with the complete original scope");
  }
  const partition = [];
  for (const batch of continuation.batches) {
    if (!Array.isArray(batch.changedPaths)
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
    partition.push(...batch.changedPaths);
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
    || continuation.fingerprint !== continuationFingerprint(scope, standard.requiredContext, continuation.batches)) {
    throw new Error("bounded continuation scope or batch fingerprints changed; prepare a fresh review");
  }
  for (const [index, batch] of continuation.batches.entries()) {
    const captured = await captureSemanticContext({
      repositoryRoot: scope.repositoryRoot,
      changedPaths: batch.changedPaths,
      contextPaths: scope.contextPaths,
      callerContextPaths: scope.callerContextPaths,
      externalContextPaths: scope.externalContextPaths,
      externalSnapshot: batch.context.externalContext,
      previousContext: batch.context,
      maxSourceBytes: scope.maxSourceBytes,
      sourceRecovery: scope.sourceRecovery,
      boundedBatch: true,
    });
    if (captured.fingerprint !== batch.context.fingerprint
      || JSON.stringify(semanticContextMissing(standard.requiredContext, captured)) !== JSON.stringify(batch.missingContext)) {
      throw new Error(`captured source or project context changed in bounded continuation batch ${index}; prepare a fresh review and discard every prior batch checkpoint`);
    }
  }
  return true;
}
