import { basename } from "node:path";

import { codeFile } from "#root/omp-plugin/semantic-source-candidates.js";

export function semanticContextMissing(requiredContext, captured) {
  const missing = [];
  const { context } = captured;
  const { evidenceBudget } = context;
  const requiredRejections = evidenceBudget.rejections.filter(record =>
    (evidenceBudget.boundedBatch && record.source !== "callers" && record.source !== "siblings")
    || (record.source === "changed-code" && requiredContext.includes("changed-code"))
    || (record.source === "project-guidance" && requiredContext.includes("project-guidance"))
    || ["targeted-context", "caller-context", "external-context"].includes(record.source));
  if (requiredRejections.length && evidenceBudget.requiredFiles > evidenceBudget.maxFiles) {
    missing.push(`required-scope capacity exceeded: ${evidenceBudget.requiredFiles} distinct required paths cannot fit the ${evidenceBudget.maxFiles}-file / ${evidenceBudget.maxBytes}-byte evidence budget. Smaller excerpts cannot reduce required file cardinality. Use review --continue to renew the complete obligation into bounded checkpoints and one final whole-scope assessment; never substitute independent fragment verdicts or drop required evidence.`);
  } else if (requiredRejections.length) {
    missing.push(`required-scope evidence capacity reached within the ${evidenceBudget.maxFiles}-file / ${evidenceBudget.maxBytes}-byte budget; inspect evidenceBudget.rejections for exact required records and limits. Recover material context ranges with review --context while retaining complete changed-source coverage. If required evidence still cannot coexist, use review --continue for bounded whole-scope continuation; optional caller/sibling omissions alone do not establish this failure.`);
  }

  if (requiredContext.includes("changed-code")) {
    if (context.changedPaths.length === 0) missing.push("changed-code scope was not supplied");
    if (context.missingChangedPaths.length) {
      missing.push(`could not capture changed files: ${context.missingChangedPaths.join(", ")}`);
      if (context.sourceRecovery) {
        const failures = context.changedCode.filter(record => record.state === "unavailable");
        missing.push(`Automatic source recovery prerequisites: ${failures.map(record => `${record.path} (${record.reason})`).join("; ")}. Unavailable required evidence keeps the review BLOCKED; automatic capture does not establish a verdict.`);
      }
      if (context.changedCode.some(record => record.rangeRecovery)) {
        missing.push("Changed-source range recovery remains available. Before adding replacements, remove each oversized or invalid retained selector from scope.contextPaths with review --remove-context '<exact-selector>'; do not retain the failed selection alongside smaller overlaps. Add bounded --context '<path#Lstart-Lend>' replacements and every omitted line in changedCodeCoverage, including the final line. Keep the complete changed scope and limits, inspect all renewed pages, then submit one assessment. If supported recovery cannot obtain the required evidence, submit explicit BLOCKED naming the prerequisite.");
      }
    }
  }

  const targetedRecords = Array.isArray(context.targetedContext)
    ? context.targetedContext.filter(record => record.content)
    : [];
  const hasCallerEvidence = (Array.isArray(context.callers) && context.callers.length > 0)
    || [...(Array.isArray(context.siblings) ? context.siblings : []), ...targetedRecords].some(record => record.source === "caller-context"
      || context.changedPaths.some(changedPath => {
        const stem = basename(changedPath).replace(/\.[^.]+$/, "");
        return stem && record.content.includes(stem);
      }));
  const siblingRecords = [
    ...(Array.isArray(context.siblings) ? context.siblings : []),
    ...(Array.isArray(context.callers) ? context.callers.filter(record => !record.partial) : []),
    ...targetedRecords.filter(record => codeFile(record.path) && !context.changedPaths.includes(record.path)),
    ...context.changedCode.filter(record => record.state === "present" && typeof record.content === "string"),
  ];
  const incompleteSiblingBoundaries = context.siblingInventory.filter(inventory =>
    !inventory.complete || (inventory.files.length > 0
      && !siblingRecords.some(record => inventory.files.includes(record.path))));
  if (requiredContext.includes("callers") && !hasCallerEvidence
    && (!context.sourceInventory.complete || context.evidenceTruncated?.callers)) {
    const retrieval = context.callerRetrieval;
    const limits = `${retrieval.inventoryFileLimit}-file inventory / ${retrieval.inventoryReadByteLimit}-byte read limits`;
    missing.push(`caller retrieval is incomplete within the bounded project evidence (${limits}; ${retrieval.omittedFiles} files omitted; ${retrieval.unreadable.length} unreadable). Inspect context.callerRetrieval for omitted paths and exact read failures. ${retrieval.recovery}`);
  }
  if (requiredContext.includes("siblings") && incompleteSiblingBoundaries.length) {
    const boundaries = incompleteSiblingBoundaries.map(inventory => {
      const candidates = inventory.files.slice(0, 3).join(", ");
      return `${inventory.path} (${inventory.reason ?? "no representative sibling source captured"}${candidates ? `; candidates: ${candidates}` : ""})`;
    });
    missing.push(`sibling retrieval is incomplete for changed boundaries: ${boundaries.join("; ")}. Inspect siblingInventory and evidenceBudget.rejections; recover material source with review --context <path[#Lstart-Lend]> without narrowing the changed scope.`);
  }
  if (requiredContext.includes("project-guidance")) {
    const unavailableGuidance = context.missingGuidancePaths.filter(path =>
      !targetedRecords.some(record => record.path === path));
    if (unavailableGuidance.length) {
      const details = unavailableGuidance.map(path => {
        const requirement = context.guidanceRequirements.find(record => record.path === path);
        return `${path} (${requirement.reason}; required by ${requirement.requiredBy.join(", ")})`;
      });
      missing.push(`could not capture project guidance: ${details.join("; ")}. Inspect context.evidenceBudget for competing records; recover material ranges with review --context. If required records cannot coexist, the review remains BLOCKED.`);
    }
  }
  if (context.missingContextPaths.length) {
    missing.push(`could not capture targeted context: ${context.missingContextPaths.join(", ")}`);
  }
  for (const record of context.externalContext ?? []) {
    if (record.state === "unavailable") {
      missing.push(`could not capture external evidence ${record.selector}: ${record.reason}. This is an evidence prerequisite, not a proved source defect.`);
    }
  }
  return missing;
}

export default semanticContextMissing;
