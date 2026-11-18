const SOURCE_GROUPS = ["changedCode", "callers", "siblings", "projectGuidance", "targetedContext", "externalContext"];
const MAX_CHECKPOINT_BYTES = 8_000;
const MAX_LEDGER_BYTES = 512_000;

export function continuationBatch(payload, index) {
  if (!payload.continuation || !Number.isSafeInteger(index) || index < 0
    || index >= payload.continuation.batches.length) {
    throw new Error("batchIndex must identify a batch in this continuation request");
  }
  return payload.continuation.batches[index];
}

export function continuationReviewPayload(payload, state, batchIndex) {
  if (!payload.continuation) {
    if (batchIndex !== undefined) throw new Error("batch selection requires review --continue first");
    return payload;
  }
  const { batches, limits } = payload.continuation;
  const assessments = state.batchAssessments ?? {};
  const nextIndex = batches.findIndex((_, index) => !assessments[index]);
  const index = batchIndex ?? (nextIndex < 0 ? null : nextIndex);
  const batch = index === null ? undefined : continuationBatch(payload, index);
  const ledger = batches.map((entry, entryIndex) => ({
    index: entryIndex,
    captureIndex: entry.captureIndex,
    changedPaths: entry.changedPaths,
    contextFingerprint: entry.context.fingerprint,
    guidancePaths: entry.context.guidanceRequirements.map(requirement => requirement.path),
    usedBytes: entry.context.evidenceBudget.usedBytes,
    evidenceRecords: entry.context.evidenceBudget.records,
    ...(assessments[entryIndex] ? { assessment: assessments[entryIndex] } : {}),
  }));
  if (Buffer.byteLength(JSON.stringify(ledger)) > MAX_LEDGER_BYTES) {
    throw new Error(`continuation ledger exceeds ${MAX_LEDGER_BYTES} bytes; shorten checkpoint rationales and citations by renewing with review --continue; no whole-scope verdict is available`);
  }
  const missingContext = batch?.missingContext ?? batches.flatMap(entry => entry.missingContext);
  const context = batch?.context ?? {
    changedPaths: payload.scope.changedPaths,
    fingerprint: payload.continuation.fingerprint,
    notes: ["Source remains in the saved batches. Reinspect material cross-batch evidence with review --batch N; checkpoint summaries are not independent whole-scope verdicts."],
  };
  return {
    ...payload,
    context,
    missingContext,
    continuation: {
      phase: batch ? "batch" : "aggregate",
      batchIndex: index,
      batchCount: batches.length,
      limits,
      batches: ledger,
    },
  };
}

export function continuationAssessmentPayload(payload, batchIndex) {
  if (!payload.continuation) {
    if (batchIndex !== undefined) throw new Error("batch assessment requires a continuation request");
    return payload;
  }
  if (batchIndex !== undefined) {
    const batch = continuationBatch(payload, batchIndex);
    return {
      ...payload,
      scope: { ...payload.scope, changedPaths: batch.changedPaths },
      context: batch.context,
      missingContext: batch.missingContext,
    };
  }
  // Only citation validation uses this union; raw combined source is never presented.
  const contexts = payload.continuation.batches.map(batch => batch.context);
  const context = { callerContextPaths: [...new Set(contexts.flatMap(entry => entry.callerContextPaths))] };
  for (const group of SOURCE_GROUPS) {
    context[group] = contexts.flatMap(entry => Array.isArray(entry[group]) ? entry[group] : []);
  }
  return {
    ...payload,
    context,
    missingContext: payload.continuation.batches.flatMap(batch => batch.missingContext),
  };
}

export function validateContinuationAssessment(assessment, payload, state) {
  if (!payload.continuation) {
    if (assessment?.batchIndex !== undefined || assessment?.coveredBatches !== undefined) {
      throw new Error("continuation assessment fields require review --continue first");
    }
    return;
  }
  if (assessment?.batchIndex !== undefined) {
    continuationBatch(payload, assessment.batchIndex);
    if (state.batchAssessments?.[assessment.batchIndex]) {
      throw new Error("this batch already has a checkpoint; inspect it with review --batch, or renew the whole request with review --continue before reassessing");
    }
    if (typeof assessment.crossBatchNotes !== "string" || !assessment.crossBatchNotes.trim()
      || assessment.crossBatchNotes.length > 4_000) {
      throw new Error("batch assessments require non-empty crossBatchNotes of at most 4000 characters describing relationships and remaining integration questions");
    }
    if (Buffer.byteLength(JSON.stringify(assessment)) > MAX_CHECKPOINT_BYTES) {
      throw new Error(`batch assessment exceeds ${MAX_CHECKPOINT_BYTES} UTF-8 bytes; shorten prose and citation excerpts without omitting material findings`);
    }
    return;
  }
  if (assessment?.status === "BLOCKED") return;
  const expected = payload.continuation.batches.map((_, index) => index);
  if (!Array.isArray(assessment?.coveredBatches)
    || JSON.stringify(assessment.coveredBatches) !== JSON.stringify(expected)) {
    throw new Error("final assessment must include coveredBatches listing every batch index in order and explain cross-batch interactions in its rationale");
  }
  const checkpoints = expected.map(index => state.batchAssessments?.[index]);
  if (checkpoints.some(checkpoint => !checkpoint)) {
    throw new Error("complete every batch checkpoint before submitting a whole-scope PASS or FAIL");
  }
  if (assessment.status === "PASS" && checkpoints.some(checkpoint => checkpoint.status !== "PASS")) {
    throw new Error("whole-scope PASS cannot override a FAIL or BLOCKED batch; resolve its finding or prerequisite and renew the complete review");
  }
  if (assessment.status === "FAIL" && checkpoints.some(checkpoint => checkpoint.status === "BLOCKED")) {
    throw new Error("a whole-scope FAIL cannot establish complete review while a batch is BLOCKED; report the unresolved prerequisite as BLOCKED");
  }
}
