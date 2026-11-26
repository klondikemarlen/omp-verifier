import assert from "node:assert/strict";
import test from "node:test";

import { presentLintAdvisor } from "#root/omp-plugin/lint-presentation.js";
import { formatVerificationResults } from "#root/omp-plugin/reporters.js";

const lintVerdictRows = [
  "FAIL — ESLint reported violations · javascript (api)",
  "Finding: api/uses  spaces.js:1:7 · no-unused-vars",
  "Message: 'unused' is assigned a value but never used.",
  "Next: fix the reported violations, then rerun the same scope.",
  "BLOCKED — lint did not complete · javascript (web)",
  "Reason: eslint could not complete",
  "Execution: Lint command terminated by SIGTERM",
  "No source violation established for this package.",
  "Next: resolve the execution problem, then retry the same scope.",
];
const evidence = [
  "javascript (api): FAIL — eslint reported lint violations",
  "Inputs (not findings):",
  "Command: eslint api/other.js api/uses\\ \\ spaces.js",
  "Retained lint output:",
  "/checkout/api/uses  spaces.js",
  "  1:7  error  'unused' is assigned a value but never used.  no-unused-vars",
  "javascript (web): BLOCKED — eslint could not complete",
  "Lint command terminated by SIGTERM",
  "Lint output truncated (64000-byte retention limit; 32000 bytes per stream)",
  `${"noise before interruption ".repeat(10)}last retained line`,
].join("\n");
const lintResult = {
  id: "verifier:project-lint",
  status: "FAIL",
  summary: "Lint execution for 2 applicable project/language group(s)",
  scope: {
    mode: "changed paths",
    attribution: "selected files",
    repositoryRoot: "/checkout",
  },
  lintVerdicts: lintVerdictRows.join("\n"),
  evidence,
};
const reportedLint = formatVerificationResults([lintResult]);

function advisorBlock(notes) {
  return {
    type: "message",
    id: "1",
    message: {
      role: "custom",
      customType: "advisor",
      details: {
        notes,
      },
    },
  };
}

function verifierNote(note) {
  return Object.freeze({
    advisor: "verifier",
    severity: "blocker",
    note,
  });
}

test("when a lint note has grouped verdicts, expansion preserves the original evidence", () => {
  // Arrange
  const note = verifierNote(reportedLint);
  const block = advisorBlock([note]);

  // Act
  const { compact } = presentLintAdvisor(block);

  // Assert
  assert.deepEqual(compact, {
    label: "Verifier lint · blocker · Ctrl+O for retained evidence",
    rows: ["Scope: changed paths; selected files; checkout /checkout", ...lintVerdictRows],
  });
  assert.equal(block.message.details.notes[0], note);
  const retainedEvidence = evidence.split("\n").map(line => `  ${line}`).join("\n");
  assert.ok(note.note.endsWith(`  Retained execution evidence:\n${retainedEvidence}`));
});

test("when a card cannot be compacted without losing context, the native renderer keeps it", () => {
  // Arrange
  const lintNote = verifierNote(reportedLint);
  const otherNote = {
    advisor: "other-advisor",
    severity: "blocker",
    note: reportedLint,
  };
  const mixedChecks = formatVerificationResults([
    lintResult,
    {
      id: "other:check",
      status: "BLOCKED",
      summary: "Independent prerequisite is unavailable",
    },
  ]);
  const malformedProjection = reportedLint.replace("Next: fix the reported violations", "unexpected argv dump");
  const legacyNote = verifierNote("BLOCKED verifier:project-lint\n  Command exited with code 1.");

  // Act
  const projections = [
    [otherNote],
    [lintNote, otherNote],
    [verifierNote(mixedChecks)],
    [verifierNote(malformedProjection)],
    [legacyNote],
  ].map(notes => presentLintAdvisor(advisorBlock(notes)));

  // Assert
  assert.deepEqual(projections, Array(5).fill(undefined));
});
