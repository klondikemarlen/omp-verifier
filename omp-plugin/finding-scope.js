export function deliveryFindingMode(delivery, changedPaths) {
  if (!delivery) {
    return "changed-files";
  }
  if (!Array.isArray(delivery.wholeFilePaths) || !Array.isArray(delivery.deletedPaths)
    || !delivery.lineRanges || typeof delivery.lineRanges !== "object" || Array.isArray(delivery.lineRanges)) {
    throw new Error("delivery finding eligibility is unavailable; capture fresh verification against the actual base");
  }
  if (delivery.wholeFilePaths.some(path => changedPaths.includes(path))) {
    return "changed-lines-and-files";
  }
  return "changed-lines";
}

export function deliveryFindingEligibility(delivery, changedPaths) {
  const mode = deliveryFindingMode(delivery, changedPaths);
  const selectedPaths = new Set(changedPaths);
  return {
    mode,
    lineRanges: Object.fromEntries(Object.entries(delivery.lineRanges).filter(([path]) => selectedPaths.has(path))),
    wholeFilePaths: delivery.wholeFilePaths.filter(path => selectedPaths.has(path)),
    deletedPaths: delivery.deletedPaths.filter(path => selectedPaths.has(path)),
  };
}

// Selection is not proof that an opaque provider attributed each diagnostic.
export function verificationScope(repositoryRoot, changedPaths, delivery, attribution) {
  const scope = {
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
  if (delivery && attribution === "semantic-findings") {
    Object.assign(scope, deliveryFindingEligibility(delivery, changedPaths));
  }
  return scope;
}

function findingText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_000) {
    throw new Error(`${name} must be non-empty text of at most 4000 characters`);
  }
  return value;
}

export function validateFindings(assessment, { changedPaths, automatic }, citations) {
  const findings = assessment.findings ?? [];
  if (!Array.isArray(findings) || findings.length > 20) {
    throw new Error("findings must be an array of at most 20 attributed findings");
  }
  if (assessment.status !== "FAIL") {
    if (findings.length) {
      throw new Error("only FAIL assessments may contain findings");
    }
    return [];
  }
  if (!findings.length) {
    throw new Error("FAIL requires a finding for each violation, attributed to the changed scope");
  }

  return findings.map(finding => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error("each finding must be an object");
    }
    const { delivery } = automatic ?? {};
    if (delivery) {
      return validateDeliveryFinding(finding, changedPaths, delivery, citations);
    }
    return validatePathFinding(finding, changedPaths, citations);
  });
}

function validatePathFinding(finding, changedPaths, citations) {
  const path = findingText(finding.path, "finding path");
  const summary = findingText(finding.summary, "finding summary");
  if (!citations.some(citation => citation.path === path)) {
    throw new Error(`finding requires a captured source citation: ${path}`);
  }
  if (changedPaths.includes(path)) {
    if (finding.introducedBy !== undefined || finding.regression !== undefined) {
      throw new Error("introducedBy and regression are only for findings in unchanged context");
    }
    return {
      path,
      summary,
    };
  }
  const introducedBy = findingText(finding.introducedBy, "unchanged-context finding introducedBy");
  const regression = findingText(finding.regression, "unchanged-context finding regression");
  if (!changedPaths.includes(introducedBy) || !citations.some(citation => citation.path === introducedBy)) {
    throw new Error(`unchanged-context regression requires a cited changed path: ${introducedBy}`);
  }
  return {
    path,
    summary,
    introducedBy,
    regression,
  };
}

function requireLineCitation(citations, path, line, label) {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  const citation = citations.find(citation => citation.path === path && citation.line === line);
  if (!citation) {
    throw new Error(`${label} requires an exact captured source citation: ${path}:${line}`);
  }
  return citation;
}

function isChangedCitation(citation, changedPaths, delivery) {
  if (!changedPaths.includes(citation.path)) {
    return false;
  }
  if (citation.state === "deleted") {
    return delivery.deletedPaths.includes(citation.path);
  }
  if (!Object.hasOwn(delivery.lineRanges, citation.path)) {
    return false;
  }
  return delivery.lineRanges[citation.path].some(([first, last]) => first <= citation.line && citation.line <= last);
}

function validateDeliveryFinding(finding, changedPaths, delivery, citations) {
  const path = findingText(finding.path, "finding path");
  const summary = findingText(finding.summary, "finding summary");
  const { line } = finding;
  const citation = requireLineCitation(citations, path, line, "finding line");
  const location = {
    path,
    line,
    summary,
    ...(citation.state === "deleted" ? {
      state: "deleted",
    } : {}),
  };
  const hasCausalAttribution = finding.introducedBy !== undefined
    || finding.introducedByLine !== undefined || finding.regression !== undefined;
  if (isChangedCitation(citation, changedPaths, delivery)) {
    if (hasCausalAttribution) {
      throw new Error("introducedBy, introducedByLine and regression are only for findings in unchanged context");
    }
    return location;
  }
  if (!hasCausalAttribution && citation.state !== "deleted"
    && changedPaths.includes(path) && delivery.wholeFilePaths.includes(path)) {
    return location;
  }

  const introducedBy = findingText(finding.introducedBy, "unchanged-context finding introducedBy");
  const { introducedByLine } = finding;
  const introducerCitation = requireLineCitation(citations, introducedBy, introducedByLine, "introducedByLine");
  const regression = findingText(finding.regression, "unchanged-context finding regression");
  if (!isChangedCitation(introducerCitation, changedPaths, delivery)) {
    throw new Error(`unchanged-context regression requires a cited changed line: ${introducedBy}:${introducedByLine}`);
  }
  return {
    ...location,
    introducedBy,
    introducedByLine,
    ...(introducerCitation.state === "deleted" ? {
      introducedByState: "deleted",
    } : {}),
    regression,
  };
}
