function indented(value) {
  const lines = [];
  for (let line of value.split("\n")) {
    while (line.length > 160) {
      let boundary = line.lastIndexOf(" ", 160);
      if (boundary < 1) boundary = line.indexOf(" ", 160);
      if (boundary < 1) break;

      lines.push(line.slice(0, boundary));
      line = line.slice(boundary + 1);
    }
    lines.push(line);
  }
  return lines.join("\n  ");
}

function formatVerificationResult(result) {
  const lines = [`${result.status} ${result.id}`, `  ${indented(result.summary)}`];
  if (result.generation) {
    lines.push(`  Generation: ${result.generation.id} (${result.generation.digest})`);
  }

  if (result.standard) {
    lines.push(`  Standard: ${indented(result.standard.source)}`);
    lines.push(`  Quality standard: ${indented(result.standard.gold)}`);
  }

  if (result.scope) {
    const scope = result.scope;
    lines.push(`  Scope: ${scope.mode}; ${scope.attribution}; checkout ${scope.repositoryRoot}`);
    if (scope.baseRef) {
      lines.push(`  Base: ${scope.baseRef} (${scope.baseCommit}); merge base ${scope.mergeBaseCommit}; head ${scope.headCommit}`);
    }
  }

  for (const finding of result.findings ?? []) {
    lines.push(`  Finding: ${indented(`${finding.path}: ${finding.summary}`)}`);
    if (finding.introducedBy) {
      lines.push(`  Introduced by: ${indented(`${finding.introducedBy}: ${finding.regression}`)}`);
    }
  }

  if (result.reviewRequest) {
    lines.push(`  Review request: ${result.reviewRequest.path}`);
  }

  if (result.evidence) {
    lines.push(`  Evidence: ${indented(result.evidence)}`);
  }

  if (result.nextCheck) {
    lines.push(`  Next check: ${indented(result.nextCheck)}`);
  }

  return lines.join("\n");
}

export function formatVerificationResults(results) {
  return results.map(formatVerificationResult).join("\n\n");
}

export function formatVerificationInventory({ checks, blockedResults }) {
  const lines = ["Verifier checks:", `discovered: ${checks.length}`];

  for (const check of checks) {
    const mode = check.mode === "agentic" ? " [agentic]" : "";
    lines.push(`${check.id}${mode} — ${check.label}: ${check.description}`);
  }

  if (blockedResults.length > 0) {
    lines.push(formatVerificationResults(blockedResults));
  }

  if (checks.length === 0 && blockedResults.length === 0) {
    lines.push("none installed");
  }

  return lines.join("\n");
}
