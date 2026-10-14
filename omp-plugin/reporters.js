function indented(value) {
  return value.replace(/\n/g, "\n  ");
}

function formatVerificationResult(result) {
  const lines = [`${result.status} ${result.id}`, `  ${indented(result.summary)}`];

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
    lines.push(`${check.id} — ${check.label}: ${check.description}`);
  }

  if (blockedResults.length > 0) {
    lines.push(formatVerificationResults(blockedResults));
  }

  if (checks.length === 0 && blockedResults.length === 0) {
    lines.push("none installed");
  }

  return lines.join("\n");
}
