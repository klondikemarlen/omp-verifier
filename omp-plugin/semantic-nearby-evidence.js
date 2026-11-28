import { createHash } from "node:crypto";

import { sourceEvidenceRecord } from "#root/omp-plugin/semantic-evidence-budget.js";
import { MAX_FILE_EVIDENCE_BYTES } from "#root/omp-plugin/semantic-project-source.js";

export function captureNearbyEvidence({ callerMatches, siblingPaths }, {
  siblingInventory,
  availableText,
  callerInventory,
  sourceInventory,
}, { changedCode, targetedContext }, budget) {
  const callers = [];
  const siblings = [];
  const capturedOptionalPaths = new Set();
  const attemptedOptionalPaths = new Set();

  for (const records of [targetedContext, changedCode]) {
    for (const record of records) {
      if (typeof record.content === "string") capturedOptionalPaths.add(record.path);
    }
  }

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

  // Reserve a representative per boundary before broad filename-matched callers.
  for (const inventory of siblingInventory) {
    if (inventory.files.some(path => capturedOptionalPaths.has(path))) continue;

    for (const path of inventory.files) {
      if (admitOptionalBody(path, siblings, "siblings")) break;
    }
  }
  for (const path of callerMatches) admitOptionalBody(path, callers, "callers");
  for (const path of siblingPaths) admitOptionalBody(path, siblings, "siblings");

  const uncapturedCallerPaths = [...callerMatches].some(path => !capturedOptionalPaths.has(path));
  const uncapturedSiblingSource = [...siblingPaths].some(path => !capturedOptionalPaths.has(path));

  return {
    callers: callers.length ? callers : absentCallerEvidence(callerMatches, capturedOptionalPaths),
    siblings: siblings.length ? siblings : absentSiblingEvidence(siblingInventory, capturedOptionalPaths),
    siblingInventory,
    callerInventory,
    sourceInventory,
    evidenceTruncated: {
      callers: uncapturedCallerPaths,
      siblings: uncapturedSiblingSource,
    },
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

function absentCallerEvidence(callerMatches, capturedOptionalPaths) {
  if ([...callerMatches].some(path => capturedOptionalPaths.has(path))) {
    return {
      status: "captured-elsewhere",
      explanation: "Filename-matched caller candidates are captured in sibling or targeted records; source relationships still require assessment.",
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
