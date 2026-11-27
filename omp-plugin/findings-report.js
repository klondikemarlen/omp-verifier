import { stripVTControlCharacters } from "node:util";

import { openFindingsReportStore } from "#root/omp-plugin/findings-report-store.js";

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TARGET_URL = /^https:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]*)\/((?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*\/)+)(pull|-\/merge_requests)\/([1-9][0-9]*)\/?$/;
const MAX_REPORT_CHECKS = 64;

export async function retainFindingsResults(results) {
  const blockers = results.filter(result => ["FAIL", "BLOCKED"].includes(result.status) && !result.reviewRequest);
  if (blockers.length === 0) return [];

  const store = await openFindingsReportStore({ create: true });
  const references = [];
  for (const result of blockers) {
    const id = await store.write({
      version: 1,
      kind: "check",
      result,
    });
    references.push({ id, checkId: result.id });
  }
  return references;
}

export async function composeFindingsReport(specification, detailCommand) {
  if (!Array.isArray(specification) || specification.length === 0) {
    throw new Error("Report composition requires an array of groups with check captures");
  }

  const store = await openFindingsReportStore();
  const groups = [];
  const previouslyGrouped = new Set();
  for (const group of specification) {
    const { target, captures } = group ?? {};
    if (!Array.isArray(captures) || captures.length === 0 || captures.length > MAX_REPORT_CHECKS) {
      throw new Error("Each findings group requires between 1 and 64 check captures");
    }

    const uniqueCaptures = [...new Set(captures)];
    const checks = [];
    for (const capture of uniqueCaptures) {
      if (previouslyGrouped.has(capture)) throw new Error("A captured check cannot belong to two findings groups");

      previouslyGrouped.add(capture);
      if (previouslyGrouped.size > MAX_REPORT_CHECKS) throw new Error("A findings report supports at most 64 captured checks");

      const { result } = await store.read(capture, "check");
      checks.push({ capture, result });
    }

    const identity = validateTarget(target, checks);
    groups.push({
      target: identity,
      checks,
      locations: groupFindingLocations(checks),
    });
  }

  const report = {
    version: 1,
    kind: "report",
    groups,
    summary: formatFindingsSummary(groups),
    detailCommand,
  };
  const id = await store.write(report);
  return findingsReportWithNote(id, report);
}

export async function readFindingsReport(id) {
  const store = await openFindingsReportStore();
  const report = await store.read(id, "report");
  return findingsReportWithNote(id, report);
}

function findingsReportWithNote(id, report) {
  const note = `${report.summary}\n\nDetails: ${report.detailCommand} ${id} --reporter text`;
  return { id, ...report, note };
}

function validateTarget(target, checks) {
  if (target === undefined) {
    if (checks.some(({ result }) => result.scope?.baseCommit)) {
      throw new Error("A captured delivery check requires its observed PR/MR target");
    }
    return null;
  }

  const { url, targetBranch, baseCommit, headCommit, repositoryRoot } = target ?? {};
  const parsed = typeof url === "string" && TARGET_URL.exec(url);
  if (!parsed || typeof targetBranch !== "string" || !targetBranch.trim() || /\s/.test(targetBranch)
    || typeof baseCommit !== "string" || !COMMIT.test(baseCommit)
    || typeof headCommit !== "string" || !COMMIT.test(headCommit)
    || typeof repositoryRoot !== "string" || !repositoryRoot) {
    throw new Error("A findings target needs an HTTPS PR/MR URL, targetBranch, full baseCommit and headCommit, and repositoryRoot");
  }

  for (const { result } of checks) {
    const scope = result.scope;
    if (scope?.repositoryRoot !== repositoryRoot || scope?.baseCommit !== baseCommit || scope?.headCommit !== headCommit) {
      throw new Error("A captured check does not match the declared PR/MR checkout and revisions");
    }
  }

  const [, host, project, route, number] = parsed;
  const marker = route === "pull" ? "#" : "!";
  return {
    url,
    label: `${host}/${project.slice(0, -1)}${marker}${number}`,
    targetBranch,
    baseCommit,
    headCommit,
    repositoryRoot,
  };
}

function groupFindingLocations(checks) {
  const locations = new Map();
  for (const { capture, result } of checks) {
    for (const finding of result.findings ?? []) {
      const { path, line, state } = finding;
      const key = JSON.stringify([path, line, state]);
      if (!locations.has(key)) {
        locations.set(key, {
          path,
          line,
          state,
          findings: [],
        });
      }
      locations.get(key).findings.push({
        capture,
        kind: result.evaluation?.mode === "agentic" ? "semantic-judgment" : "provider-finding",
        finding,
      });
    }
  }
  return [...locations.values()];
}

function compactText(value) {
  const plain = stripVTControlCharacters(value);
  const firstLine = plain.split(/\r\n|\r|\n/, 1)[0];
  const clean = firstLine.replace(/\p{Cc}/gu, " ").trim();
  const maximumLength = 240;
  if (clean.length <= maximumLength && firstLine === plain) return clean;

  return `${clean.slice(0, maximumLength)}…`;
}

function formatFindingsSummary(groups) {
  let checkCount = 0;
  let findingCount = 0;
  let opaqueCount = 0;
  for (const { checks, locations } of groups) {
    const checkIds = new Set();
    const unattributedFailures = new Set();
    for (const location of locations) findingCount += location.findings.length;
    for (const { result } of checks) {
      checkIds.add(result.id);
      if (result.status === "FAIL" && !result.findings?.length) {
        unattributedFailures.add(result.id);
      }
    }
    checkCount += checkIds.size;
    opaqueCount += unattributedFailures.size;
  }

  const checkLabel = checkCount === 1 ? "check" : "checks";
  const findingLabel = findingCount === 1 ? "attributed finding" : "attributed findings";
  let counts = `Verifier · ${checkCount} ${checkLabel} · ${findingCount} ${findingLabel}`;
  if (opaqueCount === 1) {
    counts += " · 1 failed check without a structured location";
  } else if (opaqueCount > 1) {
    counts += ` · ${opaqueCount} failed checks without structured locations`;
  }

  const sections = groups.map(group => formatFindingsGroup(group));
  return [counts, ...sections].join("\n\n");
}

function formatFindingsGroup({ target, checks, locations }) {
  const statuses = [...new Set(checks.map(({ result }) => result.status))].join(" + ");
  const identity = target ? `${target.label} · ${target.headCommit.slice(0, 7)}` : "Independent verification";
  const lines = [`${identity} · ${statuses}`];
  const checkByCapture = new Map(checks.map(({ capture, result }) => [capture, result]));

  for (const { path, line, state, findings } of locations) {
    let location = compactText(path);
    if (line !== undefined) location += `:${line}`;
    if (state === "deleted") location += " (deleted)";

    lines.push(location);
    for (const { capture, kind, finding } of findings) {
      const result = checkByCapture.get(capture);
      const label = kind === "semantic-judgment" ? "Judgment" : "Provider finding";
      lines.push(`  ${label} [${result.status} ${compactText(result.id)}]: ${compactText(finding.summary)}`);
    }
  }

  const nextActions = new Map();
  for (const { result } of checks) {
    const checkId = compactText(result.id);
    if (!result.findings?.length) {
      lines.push(`${result.status} ${checkId}: ${compactText(result.summary)}`);
      if (result.lintVerdicts) {
        for (const verdict of result.lintVerdicts.split("\n")) lines.push(`  ${compactText(verdict)}`);
      }
    }
    if (result.nextCheck) {
      if (!nextActions.has(result.nextCheck)) nextActions.set(result.nextCheck, new Set());
      nextActions.get(result.nextCheck).add(checkId);
    }
  }

  for (const [action, checkIds] of nextActions) {
    lines.push(`Next [${[...checkIds].join(", ")}]: ${compactText(action)}`);
  }
  return lines.join("\n");
}
