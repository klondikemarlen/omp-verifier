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

function findingLocation(path, line, state) {
  let location = path;
  if (line !== undefined) {
    location += `:${line}`;
  }
  if (state === "deleted") {
    location += " (deleted)";
  }
  return location;
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
    if (scope.wholeFilePaths?.length) {
      lines.push(`  Whole-file cleanup: ${indented(scope.wholeFilePaths.join(", "))}`);
    }
  }

  for (const finding of result.findings ?? []) {
    const location = findingLocation(finding.path, finding.line, finding.state);
    lines.push(`  Finding: ${indented(`${location}: ${finding.summary}`)}`);
    if (finding.introducedBy) {
      const introducer = findingLocation(finding.introducedBy, finding.introducedByLine, finding.introducedByState);
      lines.push(`  Introduced by: ${indented(`${introducer}: ${finding.regression}`)}`);
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

export function formatRunTimings(runs) {
  if (!runs.length) {
    return "No recorded verification runs in this working directory.";
  }

  return runs.map(run => {
    const started = new Date(run.startedAt).toISOString();
    const lines = [`${started}  ${run.command}`];
    if (run.coordinatorMs === null) {
      lines.push("  Coordinator finish not observed; full run unknown.");
    } else {
      const full = run.fullRunMs === null ? "completion not observed" : formatDuration(run.fullRunMs);
      lines.push(`  Coordinator: ${formatDuration(run.coordinatorMs)}; full run: ${full}`);
    }
    for (const check of run.checks) {
      const duration = check.durationMs === null ? "not timed" : formatDuration(check.durationMs);
      const outcome = check.finalStatus ? `${check.status} → ${check.finalStatus} at +${formatDuration(check.elapsedMs)}` : check.status;
      lines.push(`  ${check.id}: ${outcome} (${duration})`);
    }
    if (run.coordinatorMs !== null && !run.checks.length) {
      lines.push("  No checks selected.");
    }
    return lines.join("\n");
  }).join("\n\n");
}

function formatDuration(ms) {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.floor(ms % 60_000 / 1_000)} s`;
}
