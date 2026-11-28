import { isAbsolute, relative, resolve } from "node:path";

function matchesGlob(path, pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += "\\^$+?.()|{}[]".includes(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

function matchesProjectRule(rule, repositoryRoot, changedPath) {
  const scopedPath = relative(rule.configDirectory, resolve(repositoryRoot, changedPath));
  if (!scopedPath || scopedPath.startsWith("..") || isAbsolute(scopedPath)) return false;
  return matchesGlob(scopedPath.replaceAll("\\", "/"), rule.path);
}

function suppressionFor(checkId, repositoryRoot, changedPath, suppressions) {
  return suppressions.find(suppression => suppression.id === checkId
    && matchesProjectRule(suppression, repositoryRoot, changedPath));
}

function suppressedResult(id, match, suppression) {
  return {
    id,
    status: "SUPPRESSED",
    summary: "Automatic verification suppressed",
    evidence: `${match.path} matched ${suppression.path}: ${suppression.reason}`,
    matches: [match],
  };
}

function unscopedProviderResult(check, matches, required) {
  const declaredScope = check.executionScope === undefined ? "none" : JSON.stringify(check.executionScope);
  return {
    id: check.id,
    status: required ? "BLOCKED" : "SUPPRESSED",
    summary: required
      ? "Required verification provider does not support changed-file execution"
      : "Automatic verification skipped: provider does not support changed-file execution",
    evidence: `Delivery execution requires executionScope: "changed-files"; the provider declares ${declaredScope}.`,
    matches,
  };
}

function selectCheckMatches({ check, matches }, { repositoryRoot, suppressions, requiredPathKeys, isDelivery }) {
  const lacksDeliveryScope = isDelivery && check.mode !== "agentic" && check.executionScope !== "changed-files";
  const runnableMatches = [];
  const skippedResults = [];
  const optionalUnscopedMatches = [];
  const requiredUnscopedMatches = [];

  for (const match of matches) {
    const suppression = suppressionFor(check.id, repositoryRoot, match.path, suppressions);
    if (suppression) {
      skippedResults.push(suppressedResult(check.id, match, suppression));
    } else if (!lacksDeliveryScope) {
      runnableMatches.push(match);
    } else if (requiredPathKeys.has(`${check.id}\\0${match.path}`)) {
      requiredUnscopedMatches.push(match);
    } else {
      optionalUnscopedMatches.push(match);
    }
  }

  if (optionalUnscopedMatches.length) {
    skippedResults.push(unscopedProviderResult(check, optionalUnscopedMatches, false));
  }

  if (requiredUnscopedMatches.length) {
    skippedResults.push(unscopedProviderResult(check, requiredUnscopedMatches, true));
  }

  // Keep these results beside their check so execution preserves reporting order and waivers.
  return { check, matches: runnableMatches, skippedResults };
}

// Inputs are already validated by manifest/project discovery and path normalization.
// Planning never runs a provider or prepares a semantic request.
export function planAutomaticVerification({
  checks,
  changedPaths,
  repositoryRoot,
  requirements,
  suppressions,
  blockedResults,
  workLevel = "normal",
  isDelivery = false,
}) {
  const checksById = new Map(checks.map(check => [check.id, check]));
  const declaredRequirementIds = new Set(requirements.map(requirement => requirement.id));
  const blockedCheckIds = new Set(blockedResults.map(result => result.id));
  const results = suppressions
    .filter(suppression => !checksById.has(suppression.id) && !declaredRequirementIds.has(suppression.id))
    .map(suppression => ({
      id: suppression.id,
      status: "BLOCKED",
      summary: "Invalid verification suppression configuration",
      evidence: "suppression id is not installed or declared as a requirement",
    }));
  const selectedById = new Map();
  const missingProviders = new Map();
  const requiredPathKeys = new Set();
  const addSelection = (check, match) => {
    const selected = selectedById.get(check.id) || { check, matches: [] };
    if (!selected.matches.some(existing => existing.path === match.path)) selected.matches.push(match);
    selectedById.set(check.id, selected);
  };

  for (const check of checks) {
    if (workLevel === "quick-tweak" || !check.pathTriggers) continue;
    for (const path of changedPaths) {
      const trigger = check.pathTriggers.find(pattern => matchesGlob(path, pattern));
      if (trigger) addSelection(check, { path, trigger });
    }
  }

  for (const requirement of requirements) {
    for (const path of changedPaths) {
      if (!matchesProjectRule(requirement, repositoryRoot, path)) continue;
      const dedupeKey = `${requirement.id}\\0${path}`;
      if (requiredPathKeys.has(dedupeKey)) continue;
      requiredPathKeys.add(dedupeKey);
      const match = { path, trigger: requirement.path };
      const check = checksById.get(requirement.id);
      if (check) {
        addSelection(check, match);
        continue;
      }
      if (blockedCheckIds.has(requirement.id)) continue;

      const suppression = suppressionFor(requirement.id, repositoryRoot, path, suppressions);
      if (suppression) {
        results.push(suppressedResult(requirement.id, match, suppression));
        continue;
      }
      const missing = missingProviders.get(requirement.id) || [];
      missing.push(match);
      missingProviders.set(requirement.id, missing);
    }
  }

  for (const [id, matches] of missingProviders) {
    const matchingPaths = matches.map(match => match.path).join(", ");
    results.push({
      id,
      status: "BLOCKED",
      summary: "Required verification provider is not installed",
      evidence: `Declared requirement applies to ${matchingPaths}; no installed manifest provides ${id}.`,
      matches,
    });
  }

  const selections = Array.from(selectedById.values(), selection => selectCheckMatches(selection, {
    repositoryRoot, suppressions, requiredPathKeys, isDelivery,
  }));
  return { results, selections };
}
