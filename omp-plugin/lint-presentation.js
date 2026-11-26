import { stripVTControlCharacters } from "node:util";

export const LINT_VERDICTS = "Lint verdicts:";
export const LINT_EVIDENCE = "Retained execution evidence:";
const LINT_VERDICT_ROW = /^(?:FAIL — |BLOCKED — |Finding: |Message: |Finding details: |Reason: |Execution: |No source violation |Partial diagnostics |Scope: |Next: )/;

export function lintVerdictRows(outcome, label, { canIncreaseBudget }) {
  const rows = [];
  if (outcome.status === "FAIL") {
    let verdict = outcome.summary;
    if (outcome.tool === "eslint") {
      verdict = "ESLint reported violations";
    }
    rows.push(`FAIL — ${verdict} · ${label}`);
    if (outcome.diagnostic) {
      const { location, message, rule } = outcome.diagnostic;
      rows.push(`Finding: ${location}${rule ? ` · ${rule}` : ""}`, `Message: ${message}`);
    } else {
      rows.push("Finding details: consult the retained lint output.");
    }
    rows.push("Next: fix the reported violations, then rerun the same scope.");
  } else {
    rows.push(`BLOCKED — lint did not complete · ${label}`, `Reason: ${outcome.summary}`);
    if (outcome.executionReason) {
      rows.push(`Execution: ${outcome.executionReason}`);
    }
    if (outcome.reportedFindings || outcome.diagnosticsObserved) {
      rows.push("Partial diagnostics do not establish a completed lint verdict.");
    } else {
      rows.push("No source violation established for this package.");
    }
    if (outcome.execution === "interrupted" || outcome.execution === "not-started") {
      if (canIncreaseBudget) {
        rows.push("Next: retry the same scope with a larger lint budget.");
      } else {
        rows.push("Next: investigate the slow command, then retry the same scope.");
      }
    } else {
      rows.push("Next: resolve the execution problem, then retry the same scope.");
    }
  }
  if (outcome.wholeProjectTrigger) {
    rows.push(`Scope: whole package, selected by ${outcome.wholeProjectTrigger}`);
  }

  return rows.map(row => stripVTControlCharacters(row).replace(/[\r\n]+/g, " ").trim());
}

export function presentLintAdvisor(block) {
  if (block.type !== "message" || block.message.role !== "custom" || block.message.customType !== "advisor") return;

  // OMP presents the whole native card. Do not change a card shared with other advisors.
  const notes = block.message.details?.notes;
  if (!Array.isArray(notes) || notes.length !== 1) return;

  const [note] = notes;
  if (note?.advisor !== "verifier" || note.severity !== "blocker" || typeof note.note !== "string") return;

  const lines = note.note.split("\n");
  if (!/^(FAIL|BLOCKED) verifier:project-lint$/.test(lines[0])) return;
  // Other report blocks are unindented; literal command output is always indented by the reporter.
  if (lines.some((line, index) => index > 0 && line && !line.startsWith("  "))) return;

  const summaryStart = lines.indexOf(`  ${LINT_VERDICTS}`);
  const evidenceStart = lines.indexOf(`  ${LINT_EVIDENCE}`, summaryStart + 1);
  if (summaryStart < 0 || evidenceStart <= summaryStart + 1) return;

  const rows = lines.slice(summaryStart + 1, evidenceStart).map(line => line.trimStart());
  if (!/^(FAIL|BLOCKED) — /.test(rows[0])) return;
  if (rows.some(row => !LINT_VERDICT_ROW.test(row))) return;

  const scope = lines.slice(1, summaryStart).filter(line => line.startsWith("  Scope: "));
  rows.unshift(...scope.map(line => line.trimStart()));

  // The host uses this projection only while collapsed; expansion shows the untouched note.
  return {
    compact: {
      label: "Verifier lint · blocker · Ctrl+O for retained evidence",
      rows,
    },
  };
}
