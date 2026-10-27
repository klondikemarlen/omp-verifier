import { fileURLToPath } from "node:url";

const COORDINATOR_PATH = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const MAX_FORMATTED_PAGE_BYTES = 24_000;
const MAX_DISPLAY_LINE_BYTES = 600;
// UTF-8-safe cuts can use three fewer bytes; each continuation adds backslash + newline.
const WRAPPING_OVERHEAD_BYTES = Math.ceil(MAX_FORMATTED_PAGE_BYTES / (MAX_DISPLAY_LINE_BYTES - 3)) * 2;
const MAX_UNWRAPPED_PAGE_BYTES = MAX_FORMATTED_PAGE_BYTES - WRAPPING_OVERHEAD_BYTES;
const DISPLAY_WRAP_NOTE = "Display wraps at 600 UTF-8 bytes. Join backslash-newline continuations without adding a newline; original source line keys are unchanged.";
const NUMERIC_HEADER_ALLOWANCE = 128;
const REVIEW_PAGE_INSTRUCTION = "Read every page in separate coordinator calls, then assess the whole original scope once. PENDING is unfinished verifier work, not a final BLOCKED result or permission to complete.";

const REVIEW_RESULT_ORDER = ["id", "status", "summary", "evidence", "reviewRequest"];
const REVIEW_REQUEST_ORDER = [
  "requestId",
  "path",
  "version",
  "nonce",
  "check",
  "scope",
  "missingContext",
  "standard",
  "context",
];
const REVIEW_CONTEXT_ORDER = [
  "changedPaths",
  "changedCodeCoverage",
  "callerRetrieval",
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

function orderedReviewResult(result) {
  if (!result || typeof result !== "object" || !result.reviewRequest) return result;

  const reviewRequest = orderedObject(result.reviewRequest, REVIEW_REQUEST_ORDER);
  if (reviewRequest.context) {
    const context = orderedObject(reviewRequest.context, REVIEW_CONTEXT_ORDER);
    if (context.sourceInventory) {
      context.sourceInventory = orderedObject(context.sourceInventory, SOURCE_INVENTORY_ORDER);
    }
    reviewRequest.context = context;
  }
  return orderedObject({ ...result, reviewRequest }, REVIEW_RESULT_ORDER);
}

export function serializeSemanticReviewResults(results) {
  return JSON.stringify(results, function (key, value) {
    if (key === "content" && typeof value === "string") {
      const startLine = this.startLine ?? 1;
      return Object.fromEntries(value.split(/\r?\n/).map((line, index) => [startLine + index, line]));
    }
    if (key === "text" && typeof value === "string") {
      return value.split(/\r?\n/);
    }
    return value;
  }, 2);
}

function quoteShellArgument(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function nextReviewCommand(path, nextPageIndex) {
  const coordinator = `node ${quoteShellArgument(COORDINATOR_PATH)}`;
  const request = quoteShellArgument(path);
  if (nextPageIndex === null) {
    return `${coordinator} evaluate ${request} --assessment - --reporter text --failures-only`;
  }

  return `${coordinator} review ${request} --reporter text --page ${nextPageIndex}`;
}

function reviewContinuation(path, nextPageIndex) {
  if (nextPageIndex === null) {
    return [
      "Next action: Assess the complete scope using this request ID, then submit literal assessment JSON on stdin. Do not finish before observing the accepted final result.",
      `Next command: ${nextReviewCommand(path, null)}`,
    ].join("\n");
  }

  return [
    "Next action: Read the next page now; do not report unread pages as a blocker or finish the review.",
    `Next command: ${nextReviewCommand(path, nextPageIndex)}`,
  ].join("\n");
}

function fixedHeaderBytes(path, requestId) {
  const header = [
    "Semantic review page",
    "Review state: PENDING",
    `Request path: ${path}`,
    `Request ID: ${requestId}`,
    "Page index:  of  (zero-based)",
    "Bytes: - of  (end exclusive)",
    DISPLAY_WRAP_NOTE,
    "JSON fragment:",
    "",
    "Next page index: ",
    REVIEW_PAGE_INSTRUCTION,
    "",
  ].join("\n");
  const continuationBytes = Math.max(
    Buffer.byteLength(reviewContinuation(path, 0), "utf8"),
    Buffer.byteLength(reviewContinuation(path, null), "utf8"),
  );
  return Buffer.byteLength(header, "utf8") + continuationBytes;
}

function contentCapacity(path, requestId) {
  const capacity = MAX_UNWRAPPED_PAGE_BYTES
    - fixedHeaderBytes(path, requestId)
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
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new RangeError("Semantic review page index must be a nonnegative integer.");
  }
  if (!result || typeof result !== "object" || !result.reviewRequest) {
    throw new TypeError("Cannot build a semantic review page without a reviewRequest.");
  }

  const { requestId, path } = result.reviewRequest;
  if (typeof requestId !== "string" || typeof path !== "string") {
    throw new TypeError("Semantic review page requires a request ID and request path.");
  }

  const serialized = serializeSemanticReviewResults([orderedReviewResult(result)]);
  const buffer = Buffer.from(serialized, "utf8");
  const offsets = pageOffsets(buffer, contentCapacity(path, requestId));
  if (pageIndex >= offsets.length) {
    throw new RangeError(`Semantic review page index ${pageIndex} is out of range; page count is ${offsets.length}.`);
  }

  const { startByte, endByte } = offsets[pageIndex];
  return {
    requestId,
    path,
    index: pageIndex,
    count: offsets.length,
    startByte,
    endByte,
    totalBytes: buffer.length,
    content: buffer.toString("utf8", startByte, endByte),
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

export function formatSemanticReviewPage(page) {
  let nextPageIndex = null;
  let nextPage = "none (final page)";
  if (page.index + 1 < page.count) {
    nextPageIndex = page.index + 1;
    nextPage = String(nextPageIndex);
  }

  const output = wrapDisplayLines([
    "Semantic review page",
    "Review state: PENDING",
    `Request path: ${page.path}`,
    `Request ID: ${page.requestId}`,
    `Page index: ${page.index} of ${page.count} (zero-based)`,
    `Bytes: ${page.startByte}-${page.endByte} of ${page.totalBytes} (end exclusive)`,
    DISPLAY_WRAP_NOTE,
    "JSON fragment:",
    page.content,
    `Next page index: ${nextPage}`,
    reviewContinuation(page.path, nextPageIndex),
    REVIEW_PAGE_INSTRUCTION,
  ].join("\n"));

  if (Buffer.byteLength(output, "utf8") > MAX_FORMATTED_PAGE_BYTES) {
    throw new RangeError(`Formatted semantic review page exceeds ${MAX_FORMATTED_PAGE_BYTES} UTF-8 bytes.`);
  }
  return output;
}
