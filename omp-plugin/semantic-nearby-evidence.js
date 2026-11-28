import { createHash } from "node:crypto";

import { sourceEvidenceRecord } from "#root/omp-plugin/semantic-evidence-budget.js";
import { MAX_FILE_EVIDENCE_BYTES } from "#root/omp-plugin/semantic-project-source.js";
import { callerLineExcerpt, MAX_CALLER_LINE_BYTES } from "#root/omp-plugin/semantic-source-candidates.js";

export function captureNearbyEvidence({ callerMatches, siblingPaths, changedStems }, {
  siblingInventory,
  availableText,
  sourceHashes,
}, { changedCode, targetedContext }, {
  captureCallerSource,
  captureSiblingSource,
  compactOptionalSource,
}, budget) {
  const callers = [];
  const siblings = [];
  const capturedOptionalPaths = new Set();
  const attemptedOptionalPaths = new Set();

  for (const records of [targetedContext, changedCode]) {
    for (const record of records) {
      if (typeof record.content === "string") capturedOptionalPaths.add(record.path);
    }
  }

  // A selected range counts as caller evidence only when it contains a filename match
  // or was explicitly supplied as caller discovery.
  const capturedCallerPaths = compactOptionalSource
    ? new Set(targetedContext.filter(record => record.content && (record.source === "caller-context"
      || changedStems.some(stem => stem && record.content.includes(stem)))).map(record => record.path))
    : capturedOptionalPaths;

  function admitOptionalBody(path, records, source) {
    if (capturedOptionalPaths.has(path)) return true;
    if (attemptedOptionalPaths.has(path)) return false;

    attemptedOptionalPaths.add(path);
    const content = availableText.get(path);
    if (content === undefined) return false;

    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_EVIDENCE_BYTES) {
      budget.reject({
        path,
        source,
        bytes,
        reason: `source exceeds the ${MAX_FILE_EVIDENCE_BYTES}-byte per-file context limit; select material ranges with review --context`,
      });
      return false;
    }

    const sha256 = createHash("sha256").update(content).digest("hex");
    if (!budget.admit(records, sourceEvidenceRecord(path, { content, sha256 }, source))) return false;

    capturedOptionalPaths.add(path);
    return true;
  }

  if (captureSiblingSource) {
    // Reserve one representative per changed boundary before broad filename-matched callers.
    // Explicit source already admitted for that boundary satisfies the same requirement.
    for (const inventory of siblingInventory) {
      if (inventory.files.some(path => capturedOptionalPaths.has(path))) continue;

      for (const path of inventory.files) {
        if (!admitOptionalBody(path, siblings, "siblings")) continue;

        if (callerMatches.has(path)) capturedCallerPaths.add(path);
        break;
      }
    }
  }
  if (captureCallerSource) {
    for (const [path, matchOffset] of callerMatches) {
      if (!compactOptionalSource) {
        admitOptionalBody(path, callers, "callers");
        continue;
      }
      if (capturedCallerPaths.has(path)) continue;

      // A rejected full sibling may still supply caller evidence, but an
      // excerpt does not stand in for a representative sibling body.
      const excerpt = callerLineExcerpt(availableText.get(path), matchOffset, sourceHashes.get(path));
      if (excerpt.error) {
        budget.reject({ path, source: "callers", bytes: excerpt.bytes, reason: excerpt.error });
        continue;
      }
      if (budget.admit(callers, sourceEvidenceRecord(path, excerpt, "callers"))) {
        capturedCallerPaths.add(path);
      }
    }
  }
  if (captureSiblingSource && !compactOptionalSource) {
    for (const path of siblingPaths) admitOptionalBody(path, siblings, "siblings");
  }

  const uncapturedCallerPaths = [...callerMatches.keys()].filter(path => !capturedCallerPaths.has(path));
  const uncapturedSiblingSource = [...siblingPaths].some(path => !capturedOptionalPaths.has(path));
  const deferredCallerPaths = captureCallerSource ? [] : uncapturedCallerPaths;
  const hasDeferredSource = deferredCallerPaths.length > 0 || (!captureSiblingSource && uncapturedSiblingSource);
  const notes = [];
  if (compactOptionalSource && captureCallerSource && callerMatches.size) {
    notes.push(`Filename matches do not establish a caller relationship. Automatic discovery captures at most the first matching original line per speculative candidate (${MAX_CALLER_LINE_BYTES} UTF-8 bytes); longer lines are omitted and listed in evidenceBudget.rejections. Recover material source with review --context '<path#Lstart-Lend>' or real runner discovery with --caller-context before assessment; cite only captured lines.`);
  }
  if (compactOptionalSource && captureSiblingSource && siblingInventory.some(inventory => inventory.files.length)) {
    notes.push("Automatic sibling capture reserves one representative per required changed directory; it does not fill the remaining budget with sibling bodies. Inspect siblingInventory and recover other material source with review --context.");
  }
  if (hasDeferredSource) {
    notes.push("Optional caller or sibling source is not included unless requested by the contract or explicitly selected. Use callerRetrieval.deferredPaths and siblingInventory to find material source; recover it with review --context or --caller-context before assessment.");
  }

  return {
    callers: callers.length ? callers : absentCallerEvidence(callerMatches, capturedCallerPaths, deferredCallerPaths),
    siblings: siblings.length ? siblings : absentSiblingEvidence(siblingInventory, capturedOptionalPaths),
    deferredCallerPaths,
    evidenceTruncated: {
      callers: uncapturedCallerPaths.length > 0,
      siblings: uncapturedSiblingSource,
    },
    notes,
  };
}

function absentSiblingEvidence(siblingInventory, capturedOptionalPaths) {
  const discovered = siblingInventory.flatMap(inventory => inventory.files);
  if (discovered.some(path => capturedOptionalPaths.has(path))) {
    return {
      status: "captured-elsewhere",
      explanation: "Sibling source is captured in changed, targeted, or caller records; inspect siblingInventory for each boundary.",
    };
  }
  if (discovered.length) {
    return {
      status: "not-captured",
      explanation: "Sibling source files were discovered but not admitted; inspect siblingInventory, sourceInventory, and evidenceBudget.rejections, then select material ranges with review --context.",
    };
  }
  if (siblingInventory.some(inventory => !inventory.complete)) {
    return {
      status: "unavailable",
      explanation: "Sibling discovery is incomplete; inspect siblingInventory for the affected directories and retrieval failures.",
    };
  }
  return {
    status: "none-found",
    explanation: "No sibling source files were found in the completely inspected changed directories.",
  };
}

function absentCallerEvidence(callerMatches, capturedCallerPaths, deferredCallerPaths) {
  if ([...callerMatches.keys()].some(path => capturedCallerPaths.has(path))) {
    return {
      status: "captured-elsewhere",
      explanation: "Filename-matched caller candidates are captured in sibling or targeted records; source relationships still require assessment.",
    };
  }
  if (deferredCallerPaths.length) {
    return {
      status: "not-captured",
      explanation: "Optional caller source is deferred; inspect callerRetrieval.deferredPaths and select material evidence before assessment.",
    };
  }
  if (callerMatches.size) {
    return {
      status: "not-captured",
      explanation: "Caller candidates were found but not admitted; inspect evidenceBudget.rejections and recover material source with review --context.",
    };
  }
  return {
    status: "none-found",
    explanation: "No current project source file referenced the changed file names in the inspected inventory.",
  };
}
