import { deferredProjectGuidance } from "#root/omp-plugin/deferred-project-guidance.js";
import { sourceEvidenceRecord } from "#root/omp-plugin/semantic-evidence-budget.js";
import {
  MAX_FILE_EVIDENCE_BYTES,
  readDeliveryProjectText,
  readProjectText,
  ROOT_REVIEW_CONFIG,
} from "#root/omp-plugin/semantic-project-source.js";
import { recoverCompleteSource } from "#root/omp-plugin/semantic-required-source.js";
import { relevantGuidance } from "#root/omp-plugin/semantic-source-inventory.js";

export function selectBindingGuidance({ guidancePaths, availableText }, {
  changedPaths,
  selectedPaths,
  delivery,
  legacyRequest,
}) {
  const referenceGuideConfig = availableText.get(ROOT_REVIEW_CONFIG);
  let deferredGuides;
  if (!legacyRequest && referenceGuideConfig !== undefined) {
    deferredGuides = deferredProjectGuidance({
      config: referenceGuideConfig,
      guidancePaths,
      changedPaths: [...changedPaths, ...(delivery?.changedPaths ?? []), ...(delivery?.deletedPaths ?? [])],
      selectedPaths,
      availableText,
      includeHeadings: !delivery,
    });
  }
  const bindingGuidancePaths = guidancePaths.filter(path => !deferredGuides?.has(path));
  return { bindingGuidancePaths, deferredGuides };
}

export async function captureProjectGuidance(root, {
  bindingGuidancePaths,
  deferredGuides,
  boundaryPaths,
  changedCode,
  missingChangedPaths,
  targetedContext,
  requestedContext,
  recovery,
  deliveryScoped,
  deletedDeliveryPaths,
}, budget) {
  const readText = deliveryScoped ? readDeliveryProjectText : readProjectText;
  // Authenticated deletions remain changed-source evidence, never live instructions.
  const guidanceRequirements = bindingGuidancePaths
    .filter(path => {
      if (deletedDeliveryPaths) return !deletedDeliveryPaths.includes(path);
      return !changedCode.some(record => record.path === path && record.state === "deleted");
    })
    .map(path => ({
      path,
      requiredBy: boundaryPaths.filter(boundary => relevantGuidance(path, [boundary])),
    }));
  const records = [];
  const missingGuidancePaths = [];

  for (const requirement of guidanceRequirements) {
    const { path } = requirement;
    if (targetedContext.some(record => record.path === path && record.content)) continue;

    // A complete changed guide is already admitted; partial source cannot discharge its guidance requirement.
    if (!deletedDeliveryPaths && !missingChangedPaths.includes(path)
      && changedCode.some(record => record.path === path && record.state === "present")) {
      continue;
    }
    if (recovery && !requestedContext.some(selector => selector.path === path && selector.startLine)) {
      const reason = await recoverGuidance(readText, root, path, records, recovery, budget);
      if (reason !== undefined) {
        requirement.reason = reason;
        missingGuidancePaths.push(path);
      }
      continue;
    }
    let result = await readText(root, path);
    if (!deletedDeliveryPaths && result.sizeLimitExceeded) {
      result = await readText(root, path, MAX_FILE_EVIDENCE_BYTES, { startLine: 1 });
    }
    if (result.missing || result.error) {
      requirement.reason = result.error ?? "path is absent";
      missingGuidancePaths.push(path);
      continue;
    }
    if (!budget.admit(records, sourceEvidenceRecord(path, result, "project-guidance"))) {
      requirement.reason = budget.lastRejectionReason;
      missingGuidancePaths.push(path);
    }
  }

  let projectGuidance = records;
  if (!records.length && !deferredGuides && (!deliveryScoped || guidanceRequirements.length === 0)) {
    projectGuidance = {
      status: "none-found",
      explanation: "No recognized project guidance files were found in the inspected inventory.",
    };
  }
  let deferredGuidance;
  if (deferredGuides) {
    deferredGuidance = {
      guides: [...deferredGuides.values()],
      recovery: deletedDeliveryPaths
        ? "These unchanged reference guides are not binding evidence and were not read. Do not infer from the absent content or widen the hunk review to retrieve them."
        : deliveryScoped
        ? "These unchanged reference guides are not binding evidence and were not read. If the user explicitly authorizes the material guide and range, use review --context; do not treat the absent body as evidence."
        : "These unchanged reference guides were not captured as evidence. If material, retrieve the original lines with review --context '<path#Lstart-Lend>' before assessment; do not infer from headings or treat the absent body as evidence for PASS.",
    };
  }
  return { projectGuidance, deferredGuidance, guidanceRequirements, missingGuidancePaths };
}

async function recoverGuidance(readText, root, path, records, recovery, budget) {
  const result = await readText(root, path, recovery.maxSourceBytes);
  if (typeof result.content === "string") {
    const { coverage, error } = recoverCompleteSource(records, budget, {
      path,
      content: result.content,
      source: "project-guidance",
      recovery,
    });
    if (coverage?.complete) return undefined;
    if (error !== undefined) return error;
  }
  if (result.sizeLimitExceeded) return `source exceeds the ${recovery.maxSourceBytes}-byte automatic recovery whole-source limit`;
  return result.error ?? (result.missing ? "path is absent" : budget.lastRejectionReason ?? "context evidence limit reached");
}
