// Selection is not proof that an opaque provider attributed each diagnostic.
export function verificationScope(repositoryRoot, changedPaths, delivery, attribution) {
  return {
    mode: "changed-files",
    attribution,
    repositoryRoot,
    changedPaths: [...changedPaths],
    ...(delivery ? {
      baseRef: delivery.baseRef,
      baseCommit: delivery.baseCommit,
      mergeBaseCommit: delivery.mergeBaseCommit,
      headCommit: delivery.headCommit,
    } : {}),
  };
}

function findingText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_000) {
    throw new Error(`${name} must be non-empty text of at most 4000 characters`);
  }
  return value;
}

export function validateFindings(assessment, changedPaths, citations) {
  const findings = assessment.findings ?? [];
  if (!Array.isArray(findings) || findings.length > 20) {
    throw new Error("findings must be an array of at most 20 attributed findings");
  }
  if (assessment.status !== "FAIL") {
    if (findings.length) throw new Error("only FAIL assessments may contain findings");
    return [];
  }
  if (!findings.length) throw new Error("FAIL requires a finding for each violation, attributed to the changed scope");

  return findings.map(finding => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error("each finding must be an object");
    }
    const path = findingText(finding.path, "finding path");
    const summary = findingText(finding.summary, "finding summary");
    if (!citations.some(citation => citation.path === path)) {
      throw new Error(`finding requires a captured source citation: ${path}`);
    }
    if (changedPaths.includes(path)) {
      if (finding.introducedBy !== undefined || finding.regression !== undefined) {
        throw new Error("introducedBy and regression are only for findings in unchanged context");
      }
      return { path, summary };
    }
    const introducedBy = findingText(finding.introducedBy, "unchanged-context finding introducedBy");
    const regression = findingText(finding.regression, "unchanged-context finding regression");
    if (!changedPaths.includes(introducedBy) || !citations.some(citation => citation.path === introducedBy)) {
      throw new Error(`unchanged-context regression requires a cited changed path: ${introducedBy}`);
    }
    return { path, summary, introducedBy, regression };
  });
}
