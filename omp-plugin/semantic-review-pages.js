import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const COORDINATOR_PATH = process.env.OMP_VERIFIER_COORDINATOR
  || fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const MAX_FORMATTED_PAGE_BYTES = 24_000;
const MAX_DISPLAY_LINE_BYTES = 600;
// UTF-8-safe cuts can use three fewer bytes; each continuation adds backslash + newline.
const WRAPPING_OVERHEAD_BYTES = Math.ceil(MAX_FORMATTED_PAGE_BYTES / (MAX_DISPLAY_LINE_BYTES - 3)) * 2;
const MAX_UNWRAPPED_PAGE_BYTES = MAX_FORMATTED_PAGE_BYTES - WRAPPING_OVERHEAD_BYTES;
const DISPLAY_WRAP_NOTE = "Display wraps at 600 UTF-8 bytes. Join backslash-newline continuations without adding a newline; original source line keys are unchanged.";
const NUMERIC_HEADER_ALLOWANCE = 128;
const REVIEW_PAGE_INSTRUCTION = "You are the verifier: execute the next command with bash yourself. A standalone advise call ends this review; never use it for continuation or PENDING progress. Inspect every page, then assess the whole scope once and observe the accepted final result.";
const REVIEW_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/;

const REVIEW_RESULT_ORDER = ["id", "status", "summary", "evidence", "reviewRequest"];
const REVIEW_REQUEST_ORDER = [
  "requestId",
  "path",
  "version",
  "nonce",
  "check",
  "scope",
  "missingContext",
  "continuation",
  "standard",
  "context",
];
const REVIEW_CONTEXT_ORDER = [
  "changedPaths",
  "changedCodeCoverage",
  "callerRetrieval",
  "deferredGuidance",
  "evidenceBudget",
  "evidenceTruncated",
  "notes",
  "missingChangedPaths",
  "missingContextPaths",
  "missingGuidancePaths",
  "fingerprint",
  "changedCode",
  "callers",
  "siblings",
  "projectGuidance",
  "guidanceRequirements",
  "targetedContext",
  "sourceInventory",
  "siblingInventory",
  "callerContextPaths",
];
const SOURCE_INVENTORY_ORDER = ["complete", "omittedFiles", "note", "files"];

function orderedObject(value, preferredKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const keys = Object.keys(value);
  const orderedKeys = [
    ...preferredKeys.filter(key => Object.hasOwn(value, key)),
    ...keys.filter(key => !preferredKeys.includes(key)),
  ];
  return Object.fromEntries(orderedKeys.map(key => [key, value[key]]));
}

function sourceInventoryFileForReview(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;

  if (typeof record.path === "string"
    && Number.isSafeInteger(record.size) && record.size >= 0
    && typeof record.sha256 === "string" && SOURCE_HASH_PATTERN.test(record.sha256)
    && Object.keys(record).length === 3) {
    return record.path;
  }
  return record;
}

function orderedReviewResult(result) {
  if (!result || typeof result !== "object" || !result.reviewRequest) return result;

  const reviewRequest = orderedObject(result.reviewRequest, REVIEW_REQUEST_ORDER);
  if (reviewRequest.context) {
    const context = orderedObject(reviewRequest.context, REVIEW_CONTEXT_ORDER);
    if (context.sourceInventory) {
      const sourceInventory = orderedObject(context.sourceInventory, SOURCE_INVENTORY_ORDER);
      if (Array.isArray(sourceInventory.files)) {
        sourceInventory.files = sourceInventory.files.map(sourceInventoryFileForReview);
      }
      context.sourceInventory = sourceInventory;
    }
    reviewRequest.context = context;
  }

  // Transport metadata must not change evidence page boundaries or delivery identity.
  const canonicalResult = {
    id: result.id,
    status: result.status,
    summary: result.summary,
    reviewRequest,
  };
  if (Object.hasOwn(result, "evidence")) {
    canonicalResult.evidence = result.evidence;
  }

  return orderedObject(canonicalResult, REVIEW_RESULT_ORDER);
}

export function serializeSemanticReviewResults(results, { compact = false } = {}) {
  return JSON.stringify(results, function (key, value) {
    if (key === "content" && typeof value === "string") {
      const startLine = this.startLine ?? 1;
      return Object.fromEntries(value.split(/\r?\n/).map((line, index) => [startLine + index, line]));
    }
    if (key === "text" && typeof value === "string") {
      return value.split(/\r?\n/);
    }
    return value;
  }, compact ? undefined : 2);
}

function quoteShellArgument(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function shortReviewRequestId({ requestId }) {
  if (process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT === "1"
    && typeof requestId === "string" && requestId.length === 36
    && REVIEW_REQUEST_ID_PATTERN.test(requestId)) {
    return requestId;
  }
  return undefined;
}

export function resumeReviewCommand(requestArgument) {
  return `node ${quoteShellArgument(COORDINATOR_PATH)} review ${quoteShellArgument(requestArgument)} --resume --reporter text`;
}

function nextReviewCommand(requestArgument, nextPageIndex, batchIndex) {
  const coordinator = `node ${quoteShellArgument(COORDINATOR_PATH)}`;
  const request = quoteShellArgument(requestArgument);
  if (nextPageIndex === null) {
    return `${coordinator} evaluate ${request} --assessment - --reporter text --failures-only`;
  }

  const batchOption = batchIndex === undefined ? "" : ` --batch ${batchIndex}`;
  return `${coordinator} review ${request} --reporter text${batchOption} --page ${nextPageIndex}`;
}

function reviewContinuation(requestArgument, nextPageIndex, phase, batchIndex) {
  if (nextPageIndex === null) {
    if (phase === "batch") {
      return [
        `Next action: Submit a batch checkpoint with batchIndex: ${batchIndex}, nonempty crossBatchNotes (at most 4000 characters), and the usual assessment fields, within 8000 serialized UTF-8 bytes. This leaves the whole obligation PENDING; inspect the returned next batch or aggregate ledger.`,
        `Next command: ${nextReviewCommand(requestArgument, null)}`,
      ].join("\n");
    }
    if (phase === "aggregate") {
      return [
        "Next action: Assess the whole original scope and cross-batch interactions using every checkpoint. Submit the usual assessment fields and coveredBatches with every exact batch index; omit batchIndex. Reinspect material source with review --batch N as needed. Do not finish before observing the accepted final result.",
        `Next command: ${nextReviewCommand(requestArgument, null)}`,
      ].join("\n");
    }
    return [
      "Next action: Assess the complete scope using this request ID, then submit literal assessment JSON on stdin. Do not finish before observing the accepted final result.",
      `Next command: ${nextReviewCommand(requestArgument, null)}`,
    ].join("\n");
  }

  return [
    "Next action: Read the next page now; do not report unread pages as a blocker or finish the review.",
    `Next command: ${nextReviewCommand(requestArgument, nextPageIndex, batchIndex)}`,
  ].join("\n");
}

function reviewPageInstruction(phase, resumed = false) {
  // Resumed instructions must fit the existing page budget so old receipts still match.
  if (resumed && phase === "batch") {
    return "Delivery is not inspection. Reopen earlier pages with review --batch N --page I as needed. Inspect every page before each checkpoint and the final assessment. Never use standalone advise for PENDING progress.";
  }
  if (resumed) {
    return "Delivery is not inspection. Reopen earlier pages with review --page I as needed. Inspect every page before assessment, observe the accepted result, and never use standalone advise for PENDING progress.";
  }

  if (phase === "batch") {
    return "You are the verifier: execute the next command with bash yourself. Inspect every page of this batch before its checkpoint. A checkpoint is not a final verdict; continue through all batches and the final cross-batch assessment. Never use standalone advise for PENDING progress.";
  }
  return REVIEW_PAGE_INSTRUCTION;
}

function fixedHeaderBytes(path, requestId, phase, batchIndex) {
  const header = [
    "Semantic review page",
    "Review state: PENDING",
    `Request path: ${path}`,
    `Request ID: ${requestId}`,
    ...(phase ? [`Continuation phase: ${phase}`] : []),
    ...(batchIndex === undefined ? [] : [`Batch index: ${batchIndex} (zero-based)`]),
    "Page index:  of  (zero-based)",
    "Bytes: - of  (end exclusive)",
    DISPLAY_WRAP_NOTE,
    "JSON fragment:",
    "",
    "Next page index: ",
    reviewPageInstruction(phase),
    "",
  ].join("\n");
  const continuationBytes = Math.max(
    Buffer.byteLength(reviewContinuation(path, 0, phase, batchIndex), "utf8"),
    Buffer.byteLength(reviewContinuation(path, null, phase, batchIndex), "utf8"),
  );
  return Buffer.byteLength(header, "utf8") + continuationBytes;
}

function contentCapacity(path, requestId, phase, batchIndex) {
  const capacity = MAX_UNWRAPPED_PAGE_BYTES
    - fixedHeaderBytes(path, requestId, phase, batchIndex)
    - NUMERIC_HEADER_ALLOWANCE;
  if (capacity < 4) {
    throw new RangeError("Semantic review page header leaves no room for a UTF-8-safe JSON fragment.");
  }
  return capacity;
}

function utf8Boundary(buffer, start, limit) {
  let end = Math.min(start + limit, buffer.length);
  if (end === buffer.length) return end;

  while (end > start && end < buffer.length && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }

  if (end === start) {
    throw new RangeError("Semantic review page capacity cannot fit the next UTF-8 character.");
  }

  for (let index = end - 1; index >= start; index -= 1) {
    if (buffer[index] === 0x0a) return index + 1;
  }
  return end;
}

function pageOffsets(buffer, capacity) {
  const offsets = [];
  let startByte = 0;
  while (startByte < buffer.length) {
    const endByte = utf8Boundary(buffer, startByte, capacity);
    offsets.push({ startByte, endByte });
    startByte = endByte;
  }
  return offsets;
}

export function buildSemanticReviewPage(result, pageIndex = 0) {
  return paginateSemanticReview(result).page(pageIndex);
}

export function paginateSemanticReview(result) {
  if (!result || typeof result !== "object" || !result.reviewRequest) {
    throw new TypeError("Cannot build a semantic review page without a reviewRequest.");
  }

  const { requestId, path } = result.reviewRequest;
  if (typeof requestId !== "string" || typeof path !== "string") {
    throw new TypeError("Semantic review page requires a request ID and request path.");
  }
  const phase = result.reviewRequest.continuation?.phase;
  const batchIndex = phase === "batch" ? result.reviewRequest.continuation.batchIndex : undefined;
  if (batchIndex !== undefined && (!Number.isSafeInteger(batchIndex) || batchIndex < 0)) {
    throw new TypeError("Semantic review batch index must be a nonnegative integer.");
  }
  if (phase === "batch" && batchIndex === undefined) {
    throw new TypeError("Semantic batch review requires a batch index.");
  }

  const serialized = serializeSemanticReviewResults([orderedReviewResult(result)], {
    compact: true,
  });
  const buffer = Buffer.from(serialized, "utf8");
  // Reserve space for full-path output so either command form keeps the same page receipt identity.
  const capacity = contentCapacity(path, requestId, phase, batchIndex);
  const offsets = pageOffsets(buffer, capacity);
  const count = offsets.length;
  const viewFingerprint = createHash("sha256").update(String(capacity)).update("\n").update(buffer).digest("hex");

  return {
    batchIndex,
    count,
    viewFingerprint,
    totalBytes: buffer.length,
    page(index) {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new RangeError("Semantic review page index must be a nonnegative integer.");
      }

      if (index >= count) {
        throw new RangeError(`Semantic review page index ${index} is out of range; page count is ${count}.`);
      }

      const { startByte, endByte } = offsets[index];
      return {
        requestId,
        path,
        viewFingerprint,
        ...(phase ? {
          continuationPhase: phase,
        } : {}),
        ...(batchIndex === undefined ? {} : {
          batchIndex,
        }),
        index,
        count,
        startByte,
        endByte,
        totalBytes: buffer.length,
        content: buffer.toString("utf8", startByte, endByte),
      };
    },
  };
}

function wrapDisplayLines(text) {
  return text.split("\n").map(line => {
    if (Buffer.byteLength(line) <= MAX_DISPLAY_LINE_BYTES) return line;

    const buffer = Buffer.from(line, "utf8");
    const parts = [];
    let start = 0;
    while (buffer.length - start > MAX_DISPLAY_LINE_BYTES) {
      const end = utf8Boundary(buffer, start, MAX_DISPLAY_LINE_BYTES);
      parts.push(`${buffer.toString("utf8", start, end)}\\`);
      start = end;
    }
    parts.push(buffer.toString("utf8", start));
    return parts.join("\n");
  }).join("\n");
}

export function formatSemanticReviewPage(page, { resumed = false } = {}) {
  let nextPageIndex = null;
  let nextPage = "none (final page)";
  if (page.index + 1 < page.count) {
    nextPageIndex = page.index + 1;
    nextPage = String(nextPageIndex);
  }

  const shortRequestId = shortReviewRequestId(page);
  const requestArgument = shortRequestId ?? page.path;
  const output = wrapDisplayLines([
    "Semantic review page",
    "Review state: PENDING",
    ...(shortRequestId ? [] : [`Request path: ${page.path}`]),
    `Request ID: ${page.requestId}`,
    ...(page.continuationPhase ? [`Continuation phase: ${page.continuationPhase}`] : []),
    ...(page.batchIndex === undefined ? [] : [`Batch index: ${page.batchIndex} (zero-based)`]),
    `Page index: ${page.index} of ${page.count} (zero-based)`,
    `Bytes: ${page.startByte}-${page.endByte} of ${page.totalBytes} (end exclusive)`,
    DISPLAY_WRAP_NOTE,
    "JSON fragment:",
    page.content,
    `Next page index: ${nextPage}`,
    reviewContinuation(requestArgument, nextPageIndex, page.continuationPhase, page.batchIndex),
    reviewPageInstruction(page.continuationPhase, resumed),
  ].join("\n"));

  if (Buffer.byteLength(output, "utf8") > MAX_FORMATTED_PAGE_BYTES) {
    throw new RangeError(`Formatted semantic review page exceeds ${MAX_FORMATTED_PAGE_BYTES} UTF-8 bytes.`);
  }
  return output;
}
