import { createHash } from "node:crypto";

import { sourceEvidenceRecord } from "#root/omp-plugin/semantic-evidence-budget.js";
import {
  deletedProjectSource,
  MAX_FILE_EVIDENCE_BYTES,
  MAX_INVENTORY_FILE_BYTES,
  readProjectText,
} from "#root/omp-plugin/semantic-project-source.js";

export const MAX_TARGETED_RANGE_BYTES = 8_000_000;

export async function captureChangedSource(root, {
  changedPaths,
  requestedContext,
  previousContext,
  deletedSources,
  sourceByteLimit,
  recovery,
  delivery,
  legacyRequest,
}, budget) {
  const changedCode = [];
  const missingChangedPaths = [];
  const changedCodeCoverage = [];
  const recoveredSelectorPaths = new Set();

  function markUnavailable(path, reason, rangeRecovery = false) {
    changedCode.push({ path, state: "unavailable", reason, ...(rangeRecovery ? { rangeRecovery: true } : {}) });
    missingChangedPaths.push(path);
  }

  function captureCompleteChange(path, content, identity) {
    const { coverage, error } = recoverCompleteSource(changedCode, budget, {
      path,
      content,
      source: "changed-code",
      recovery,
      identity,
    });
    if (coverage) changedCodeCoverage.push({ path, ...coverage });
    if (!coverage?.complete) {
      markUnavailable(path, error ?? budget.lastRejectionReason ?? "context evidence limit reached");
    }
  }

  for (const path of changedPaths) {
    const selectedRanges = requestedContext.filter(selector => selector.path === path && selector.startLine);
    const recoverWholeSource = recovery && !selectedRanges.length;
    const changedSourceLimit = recoverWholeSource ? recovery.maxSourceBytes : sourceByteLimit;
    const result = await readProjectText(root, path, changedSourceLimit);
    if (result.missing) {
      // Cite true delivery deletions from the merge base, not a transient earlier request.
      let cachedSource;
      if (!delivery?.deletedPaths?.includes(path)) {
        cachedSource = previousSource(previousContext, path);
      }
      let priorSource;
      if (cachedSource !== undefined) {
        priorSource = { ...cachedSource, oversized: Buffer.byteLength(cachedSource.content) > changedSourceLimit };
      } else if (deletedSources.has(path)) {
        priorSource = deletedSources.get(path);
      } else {
        priorSource = await deletedProjectSource(root, path, changedSourceLimit, {
          identifyOversized: !legacyRequest,
          delivery,
        });
      }
      if (!priorSource) {
        markUnavailable(path, "path is absent and no prior source confirms its deletion");
        continue;
      }
      if (priorSource.oversized || Buffer.byteLength(priorSource.content ?? "") > changedSourceLimit) {
        const limitKind = recoverWholeSource ? "automatic recovery whole-source" : "changed-source";
        markUnavailable(path, `deleted source exceeds the ${changedSourceLimit}-byte ${limitKind} limit`);
        continue;
      }
      if (recoverWholeSource) {
        captureCompleteChange(path, priorSource.content, {
          state: "deleted",
          previousSha256: sha256(priorSource.content),
          ...(priorSource.reference ? { reference: priorSource.reference } : {}),
        });
        continue;
      }
      const deletedRecord = {
        path,
        source: "changed-code",
        state: "deleted",
        content: priorSource.content,
        previousSha256: sha256(priorSource.content),
        ...(priorSource.reference ? { reference: priorSource.reference } : {}),
      };
      if (!budget.admit(changedCode, deletedRecord)) {
        markUnavailable(path, "context evidence limit reached");
      }
      continue;
    }
    if (recoverWholeSource && typeof result.content === "string") {
      captureCompleteChange(path, result.content);
      continue;
    }
    if (recoverWholeSource && result.sizeLimitExceeded) {
      markUnavailable(path, `source exceeds the ${changedSourceLimit}-byte automatic recovery whole-source limit`);
      continue;
    }
    if (result.sizeLimitExceeded) {
      if (!selectedRanges.length) {
        markUnavailable(path, result.error, result.rangeRecovery);
        continue;
      }
      recoveredSelectorPaths.add(path);
      const { coverage, reason, rangeRecovery } = await captureSelectedRanges(
        root, path, selectedRanges, changedCode, budget,
      );
      if (reason !== undefined) {
        markUnavailable(path, reason, rangeRecovery);
      }
      changedCodeCoverage.push({ path, ...coverage });
      continue;
    }
    if (result.error) {
      markUnavailable(path, result.error);
      continue;
    }
    if (!budget.admit(changedCode, sourceEvidenceRecord(path, result, "changed-code"))) {
      markUnavailable(path, "context evidence limit reached");
    }
  }

  return { changedCode, changedCodeCoverage, missingChangedPaths, recoveredSelectorPaths };
}

export function validateSourceRecovery(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sourceRecovery must be an object");
  }

  for (const [name, maximum] of [["chunkBytes", MAX_FILE_EVIDENCE_BYTES], ["maxSourceBytes", MAX_INVENTORY_FILE_BYTES]]) {
    if (!Number.isSafeInteger(value[name]) || value[name] <= 0 || value[name] > maximum) {
      throw new RangeError(`sourceRecovery.${name} must be a positive safe integer no greater than ${maximum}`);
    }
  }

  return { chunkBytes: value.chunkBytes, maxSourceBytes: value.maxSourceBytes, modelContext: value.modelContext };
}

export function recoverCompleteSource(records, budget, { path, content, source, recovery, identity }) {
  if (Buffer.byteLength(content) > recovery.maxSourceBytes) {
    return { error: `source exceeds the ${recovery.maxSourceBytes}-byte automatic recovery whole-source limit` };
  }

  // Keep CRLF bytes intact so complete cached chunks can authenticate the original source.
  const lines = content.split("\n");
  const ranges = [];
  let startLine = 1;
  let bytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineBytes = Buffer.byteLength(lines[index]);
    if (lineBytes > recovery.chunkBytes) {
      return { error: `source line ${index + 1} exceeds the ${recovery.chunkBytes}-byte automatic recovery chunk limit` };
    }
    if (index + 1 > startLine && bytes + 1 + lineBytes > recovery.chunkBytes) {
      ranges.push([startLine, index]);
      startLine = index + 1;
      bytes = lineBytes;
    } else {
      bytes += (index + 1 > startLine ? 1 : 0) + lineBytes;
    }
  }

  ranges.push([startLine, lines.length]);
  const sourceHash = sha256(content);
  const admittedRanges = [];
  for (const range of ranges) {
    const [startLine, endLine] = range;
    const record = sourceEvidenceRecord(path, {
      content: lines.slice(startLine - 1, endLine).join("\n"),
      sha256: sourceHash,
      lineCount: lines.length,
      startLine,
      endLine,
      partial: ranges.length > 1,
    }, source);
    if (!budget.admit(records, identity ? { ...record, ...identity } : record)) break;
    admittedRanges.push(range);
  }

  return { coverage: { lineCount: lines.length, ...lineCoverage(admittedRanges, lines.length) } };
}

async function captureSelectedRanges(root, path, selectors, changedCode, budget) {
  const chunks = [];
  let identity;

  // Establish one full-source identity before admitting any of the selected ranges.
  for (const [startLine, endLine] of disjointLineRanges(selectors)) {
    const range = { startLine, endLine };
    const chunk = await readProjectText(root, path, MAX_FILE_EVIDENCE_BYTES, range, MAX_TARGETED_RANGE_BYTES);
    if (chunk.error || chunk.missing) {
      return {
        coverage: incompleteCoverage(identity),
        reason: chunk.error ?? "source disappeared while selected ranges were being captured",
        rangeRecovery: chunk.rangeRecovery === true,
      };
    }
    if (identity && (identity.sha256 !== chunk.sha256 || identity.size !== chunk.size || identity.lineCount !== chunk.lineCount)) {
      return {
        coverage: incompleteCoverage(identity),
        reason: "full-source identity changed between selected ranges",
      };
    }
    identity ??= { sha256: chunk.sha256, size: chunk.size, lineCount: chunk.lineCount };
    chunks.push({ chunk, startLine, endLine });
  }
  if (!identity) {
    return {
      coverage: incompleteCoverage(identity),
      reason: "selected changed source ranges could not be captured consistently",
    };
  }

  const admittedRanges = [];
  let admissionFailed = false;
  for (const { chunk, startLine, endLine } of chunks) {
    const record = sourceEvidenceRecord(path, {
      ...chunk,
      lineCount: identity.lineCount,
      partial: true,
    }, "changed-code");
    if (!budget.admit(changedCode, record)) {
      admissionFailed = true;
      break;
    }
    admittedRanges.push([startLine, endLine]);
  }

  const coverage = { lineCount: identity.lineCount, ...lineCoverage(admittedRanges, identity.lineCount) };
  if (admissionFailed) {
    return { coverage, reason: "context evidence limit reached" };
  }
  if (!coverage.complete) {
    return { coverage, reason: "selected ranges do not cover the complete changed source", rangeRecovery: true };
  }
  return { coverage };
}

function incompleteCoverage(identity) {
  return {
    lineCount: identity?.lineCount ?? null,
    coveredRanges: [],
    omittedRanges: identity?.lineCount ? [[1, identity.lineCount]] : [],
    complete: false,
  };
}

function previousSource(previousContext, path) {
  const records = previousContext?.changedCode?.filter(record => record.path === path && typeof record.content === "string") ?? [];
  const coverage = previousContext?.changedCodeCoverage?.find(record => record.path === path);
  if (coverage) {
    if (!coverage.complete || !records.length) return undefined;

    const ordered = records.sort((left, right) => (left.startLine ?? 1) - (right.startLine ?? 1));
    let nextLine = 1;
    for (const record of ordered) {
      if ((record.startLine ?? 1) !== nextLine) return undefined;
      nextLine += record.content.split("\n").length;
    }

    const content = ordered.map(record => record.content).join("\n");
    const sourceHash = sha256(content);
    if (nextLine !== coverage.lineCount + 1
      || ordered.some(record => (record.previousSha256 ?? record.sha256) !== sourceHash)) return undefined;
    if (ordered.some(record => record.reference !== ordered[0].reference)) return undefined;
    return { content, ...(ordered[0].reference ? { reference: ordered[0].reference } : {}) };
  }
  if (records.length !== 1 || records[0].partial || records[0].startLine > 1) return undefined;
  return { content: records[0].content, ...(records[0].reference ? { reference: records[0].reference } : {}) };
}

function disjointLineRanges(selectors) {
  const ranges = selectors
    .map(({ startLine, endLine }) => [startLine, endLine])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const chunks = [];
  let coveredEnd = 0;

  for (const [start, end] of ranges) {
    if (end <= coveredEnd) continue;

    chunks.push([Math.max(start, coveredEnd + 1), end]);
    coveredEnd = end;
  }

  return chunks;
}

function lineCoverage(ranges, lineCount) {
  const coveredRanges = [];
  for (const [start, end] of ranges) {
    const previous = coveredRanges[coveredRanges.length - 1];
    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], Math.min(end, lineCount));
    } else {
      coveredRanges.push([start, Math.min(end, lineCount)]);
    }
  }

  const omittedRanges = [];
  let nextLine = 1;
  for (const [start, end] of coveredRanges) {
    if (start > nextLine) omittedRanges.push([nextLine, start - 1]);
    nextLine = Math.max(nextLine, end + 1);
  }
  if (nextLine <= lineCount) omittedRanges.push([nextLine, lineCount]);
  return { coveredRanges, omittedRanges, complete: omittedRanges.length === 0 };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
