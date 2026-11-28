import { isDeepStrictEqual } from "node:util";

import { validateFindings, verificationScope } from "#root/omp-plugin/finding-scope.js";
import { validateSemanticCitations } from "#root/omp-plugin/semantic-citations.js";
import { continuationAssessmentPayload, validateContinuationAssessment } from "#root/omp-plugin/semantic-continuation-review.js";

const VERDICTS = new Set(["PASS", "FAIL", "BLOCKED"]);
const MAX_TEXT_LENGTH = 4_000;

export function isSemanticVerdict(status) {
  return VERDICTS.has(status);
}

export function validSemanticText(value, name, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${name} must be a ${optional ? "string" : "non-empty string"} no longer than ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

export function normalizeSemanticAssessment(assessment, request, state) {
  validateContinuationAssessment(assessment, request, state);
  const batchIndex = assessment?.batchIndex;
  const payload = continuationAssessmentPayload(request, batchIndex);
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) {
    throw new Error("assessment must be an object");
  }
  if (assessment.requestId !== payload.requestId) throw new Error("assessment requestId does not match the current request");
  if (!isSemanticVerdict(assessment.status)) throw new Error("assessment status must be PASS, FAIL, or BLOCKED");
  const summary = validSemanticText(assessment.summary, "summary");
  const rationale = validSemanticText(assessment.rationale, "rationale");
  const nextCheck = validSemanticText(assessment.nextCheck, "nextCheck", {
    optional: true,
  });
  const citations = assessment.citations === undefined ? [] : assessment.citations;
  if (!Array.isArray(citations)) throw new Error("citations must be an array");
  if (citations.length > 20) throw new Error("citations must not exceed 20 evidence locations");
  if (assessment.status === "PASS" || assessment.status === "FAIL") {
    if (payload.missingContext.length) throw new Error(`required context is unavailable: ${payload.missingContext.join("; ")}`);
    const validatedCitations = validateSemanticCitations(citations, payload.context);
    if (batchIndex === undefined && !validatedCitations.some(citation => payload.scope.changedPaths.includes(citation.path))) {
      throw new Error("PASS and FAIL citations must include a path in the current changed scope");
    }
    if (batchIndex === undefined && payload.context.callerContextPaths.length
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

export function finalAssessmentResult(payload, assessment, state) {
  const finalResult = resultFromAssessment(payload, assessment);
  if (!payload.continuation) return finalResult;

  const batches = payload.continuation.batches.map((batch, index) => ({
    index,
    contextFingerprint: batch.context.fingerprint,
    status: state.batchAssessments?.[index]?.status ?? "PENDING",
  }));
  finalResult.evaluation.continuation = {
    fingerprint: payload.continuation.fingerprint,
    batches,
  };
  for (const batch of batches) {
    if (batch.status !== "FAIL" && batch.status !== "BLOCKED") continue;
    const checkpoint = resultFromAssessment(payload, state.batchAssessments[batch.index]);
    for (const finding of checkpoint.findings ?? []) {
      finalResult.findings ??= [];
      if (!finalResult.findings.some(existing => isDeepStrictEqual(existing, finding))) {
        finalResult.findings.push(finding);
      }
    }
    for (const citation of checkpoint.citations ?? []) {
      finalResult.citations ??= [];
      if (!finalResult.citations.some(existing => isDeepStrictEqual(existing, citation))) {
        finalResult.citations.push(citation);
      }
    }
    finalResult.evidence += `\nBatch ${batch.index} ${checkpoint.status}: ${checkpoint.summary}\n${checkpoint.evidence}`;
    if (checkpoint.nextCheck) finalResult.evidence += `\nNext check: ${checkpoint.nextCheck}`;
  }
  return finalResult;
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
    ...(assessment.citations.length ? { citations: assessment.citations } : {}),
    ...(assessment.findings?.length ? { findings: assessment.findings } : {}),
    ...(assessment.nextCheck ? { nextCheck: assessment.nextCheck } : {}),
    standard: {
      id: payload.standard.id,
      source: payload.standard.source,
      gold: payload.standard.gold,
    },
    evaluation: {
      mode: "agentic",
      requestId: payload.requestId,
    },
  };
}
