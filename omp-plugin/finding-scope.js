export function deliveryFindingMode(delivery, changedPaths) {
  if (!delivery) {
    return "changed-files";
  }
  if (!Array.isArray(delivery.wholeFilePaths) || !Array.isArray(delivery.deletedPaths)
    || !delivery.lineRanges || typeof delivery.lineRanges !== "object" || Array.isArray(delivery.lineRanges)) {
    throw new Error("delivery finding eligibility is unavailable; capture fresh verification against the actual base");
  }
  if (delivery.reviewScope !== undefined) {
    if ((delivery.reviewScope !== "commit" && delivery.reviewScope !== "final")
      || delivery.wholeFilePaths.length
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(delivery.comparisonCommit)
      || !delivery.removedLineRanges || typeof delivery.removedLineRanges !== "object"
      || Array.isArray(delivery.removedLineRanges)) {
      throw new Error("changed hunk finding eligibility is unavailable; capture fresh commit or final review against the actual base");
    }
    return "changed-lines";
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
    ...(delivery.reviewScope !== undefined ? {
      removedLineRanges: Object.fromEntries(Object.entries(delivery.removedLineRanges).filter(([path]) => selectedPaths.has(path))),
      ...(delivery.renames ? { renames: delivery.renames.filter(rename => selectedPaths.has(rename.to) || selectedPaths.has(rename.from)) } : {}),
    } : {}),
    wholeFilePaths: delivery.wholeFilePaths.filter(path => selectedPaths.has(path)),
    deletedPaths: delivery.deletedPaths.filter(path => selectedPaths.has(path)),
  };
}

export function automaticEvidenceScope(automatic, changedPaths) {
  if (!automatic) {
    return undefined;
  }
  const { delivery } = automatic;
  const eligibility = deliveryFindingEligibility(delivery, changedPaths);
  return {
    packageDirectory: automatic.packageDirectory,
    workLevel: automatic.workLevel,
    baseRef: delivery.baseRef,
    baseCommit: delivery.baseCommit,
    mergeBaseCommit: delivery.mergeBaseCommit,
    ...(delivery.reviewScope !== undefined ? {
      reviewScope: delivery.reviewScope,
      comparisonCommit: delivery.comparisonCommit,
      headCommit: delivery.headCommit,
    } : {}),
    wholeFileSelectors: delivery.wholeFilePaths,
    eligibility,
  };
}

// Selection is not proof that an opaque provider attributed each diagnostic.
export function verificationScope(repositoryRoot, changedPaths, delivery, attribution) {
  const scope = {
    mode: delivery?.reviewScope === undefined ? "changed-files" : "changed-lines",
    attribution,
    repositoryRoot,
    changedPaths: [...changedPaths],
    ...(delivery ? {
      baseRef: delivery.baseRef,
      baseCommit: delivery.baseCommit,
      mergeBaseCommit: delivery.mergeBaseCommit,
      headCommit: delivery.headCommit,
    } : {}),
    ...(delivery?.reviewScope !== undefined ? {
      reviewScope: delivery.reviewScope,
      comparisonCommit: delivery.comparisonCommit,
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

function requireLineCitation(citations, path, line, label, { hunkScoped, state }) {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  if (hunkScoped && state !== undefined && state !== "present" && state !== "deleted") {
    throw new Error(`${label} state must be "present" or "deleted"`);
  }
  const matches = citations.filter(citation => citation.path === path && citation.line === line
    && (!hunkScoped || state === undefined || (citation.state ?? "present") === state));
  const citation = (hunkScoped ? matches.find(match => match.reference) : undefined) ?? matches[0];
  if (!citation) {
    throw new Error(`${label} requires an exact captured source citation: ${path}:${line}`);
  }
  if (hunkScoped && matches.some(match => match.state !== citation.state)) {
    throw new Error(`${label} requires state "present" or "deleted" to identify the captured side: ${path}:${line}`);
  }
  return citation;
}

function isChangedCitation(citation, changedPaths, delivery) {
  if (!changedPaths.includes(citation.path)) {
    return false;
  }
  if (delivery.reviewScope !== undefined) {
    const ranges = citation.state === "deleted" ? delivery.removedLineRanges : delivery.lineRanges;
    const expectedReference = citation.state === "deleted"
      ? `${delivery.comparisonCommit}:${delivery.renames?.find(rename => rename.to === citation.path)?.from ?? citation.path}`
      : `${delivery.headCommit}:${citation.path}`;
    return Boolean(citation.reference === expectedReference && Object.hasOwn(ranges, citation.path)
      && ranges[citation.path].some(([first, last]) => first <= citation.line && citation.line <= last));
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
  const hunkScoped = delivery.reviewScope !== undefined;
  const citation = requireLineCitation(citations, path, line, "finding line", {
    hunkScoped,
    state: finding.state,
  });
  const location = {
    path,
    line,
    summary,
    ...(citation.state === "deleted" ? {
      state: "deleted",
    } : {}),
  };
  const hasCausalAttribution = finding.introducedBy !== undefined
    || finding.introducedByLine !== undefined || finding.regression !== undefined
    || (hunkScoped && finding.introducedByState !== undefined);
  if (isChangedCitation(citation, changedPaths, delivery)) {
    if (hasCausalAttribution) {
      throw new Error("introducedBy, introducedByLine and regression are only for findings in unchanged context");
    }
    return location;
  }
  if (hunkScoped) {
    throw new Error(`commit and final review findings must cite a changed hunk: ${path}:${line}`);
  }
  if (!hasCausalAttribution && citation.state !== "deleted"
    && changedPaths.includes(path) && delivery.wholeFilePaths.includes(path)) {
    return location;
  }

  const introducedBy = findingText(finding.introducedBy, "unchanged-context finding introducedBy");
  const { introducedByLine } = finding;
  const introducerCitation = requireLineCitation(citations, introducedBy, introducedByLine, "introducedByLine", { hunkScoped });
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
