import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const SOURCE_PATH = "tests/workflow-step.test.ts";
const SOURCE_LINE = 'test("when the editor is stale, a rescuer can finish", () => {});';
const ALIGNMENT_EVIDENCE = `${SOURCE_PATH}:1: 10 direct expect calls; expected exactly 1.  \r\n\r\n${SOURCE_PATH}:1: ordered AAA markers not recognized.\n`;

async function reportFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-findings-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const provider = join(root, "plugins", "node_modules", "publisher");
  const recordsDirectory = join(agentDir, "verifier", "findings-reports");
  await mkdir(join(cwd, "tests"), { recursive: true });
  await mkdir(provider, { recursive: true });
  await writeFile(join(root, "plugins", "package.json"), JSON.stringify({
    name: "omp-plugins",
    dependencies: { publisher: "1.0.0" },
  }));
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher",
    version: "1.0.0",
    omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: "publisher:alignment",
        label: "Fixture Test Alignment",
        description: "Returns the provider's diagnostic without machine attribution",
        entry: "./alignment.mjs",
        pathTriggers: [SOURCE_PATH],
      }, {
        id: "publisher:focus",
        label: "Fixture Assertion Focus",
        description: "Assesses the protected stale-edit and rescue sequence",
        mode: "agentic",
        contract: "./focus.json",
        pathTriggers: [SOURCE_PATH],
      }],
    },
  }));
  await writeFile(join(provider, "alignment.mjs"), `
process.stdout.write(JSON.stringify({
  status: "FAIL",
  summary: "Test alignment reported 2 violations.",
  evidence: ${JSON.stringify(ALIGNMENT_EVIDENCE)},
  nextCheck: "Check the expectation count and ordered comment markers.",
}));
process.exitCode = 1;
`);
  await writeFile(join(provider, "focus.md"), "Assertions should protect the workflow outcome.\n");
  await writeFile(join(provider, "focus.json"), JSON.stringify({
    version: 1,
    standardId: "publisher:focus",
    source: "./focus.md",
    gold: "Assertions should protect the workflow outcome.",
    requiredContext: ["changed-code"],
    rubric: [{
      id: "outcome",
      question: "Do assertions protect the stale-edit and rescue sequence?",
    }],
  }));

  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("-c", "user.name=Verifier Tests", "-c", "user.email=test@example.com", "commit", "--allow-empty", "--quiet", "-m", "PR base");
  const baseCommit = git("rev-parse", "HEAD");
  await writeFile(join(cwd, SOURCE_PATH), `${SOURCE_LINE}\n`);
  git("add", SOURCE_PATH);
  git("-c", "user.name=Verifier Tests", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "PR head");
  const headCommit = git("rev-parse", "HEAD");
  const run = (args, { input, workingDirectory = cwd, profile = agentDir } = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: workingDirectory,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      OMP_VERIFIER_RETAIN_FINDINGS: "1",
      OMP_VERIFIER_COORDINATOR: CLI,
      OMP_VERIFIER_PACKAGE_DIRECTORY: join(root, "plugins", "node_modules"),
      PI_CODING_AGENT_DIR: profile,
    },
  });

  return {
    run,
    root,
    cwd,
    recordsDirectory,
    target: {
      url: "https://github.com/example/workflows/pull/895",
      targetBranch: "main",
      baseCommit,
      headCommit,
      repositoryRoot: cwd,
    },
  };
}

function captureId(result, checkId) {
  assert.equal(result.status, 1, result.stderr);
  const prefix = "Verifier findings capture ";
  const line = result.stderr.split("\n").find(line => line.startsWith(prefix) && line.endsWith(` (${checkId})`));
  return line.slice(prefix.length, prefix.length + 64);
}

function composeReport(run, groups) {
  return run(["report", "compose", "-"], { input: JSON.stringify(groups) });
}

function reportId(composition) {
  assert.equal(composition.status, 0, composition.stderr);
  return composition.stdout.match(/ ([a-f0-9]{64}) --reporter text\n$/)[1];
}

test("when an automatic failure and an accepted semantic failure share a PR, the exact compact note links both retained results", async t => {
  // Arrange
  const { run, root, target } = await reportFixture(t);
  const automatic = run(["automatic", "--base", target.baseCommit, "--failures-only"]);
  const automaticResults = JSON.parse(automatic.stdout);
  const alignment = automaticResults.find(result => result.id === "publisher:alignment");
  const reviewRequest = automaticResults.find(result => result.id === "publisher:focus").reviewRequest;
  const alignmentCapture = captureId(automatic, "publisher:alignment");
  const citation = {
    path: SOURCE_PATH,
    line: 1,
    quote: SOURCE_LINE,
  };
  const evaluation = run(["evaluate", reviewRequest.path, "--assessment", "-"], {
    input: JSON.stringify({
      requestId: reviewRequest.requestId,
      status: "FAIL",
      summary: "The outcome needs distinct assertion focus.",
      rationale: "The semantic judgment does not establish an expectation count.\nComment layout is not material to this judgment.",
      citations: [citation],
      findings: [{
        path: SOURCE_PATH,
        line: 1,
        summary: "Separate unrelated assertion outcomes.",
      }, {
        path: SOURCE_PATH,
        line: 1,
        summary: "Assert stale-edit rejection independently.",
      }],
      nextCheck: "Preserve the stale-edit and rescue sequence.",
    }),
  });
  const focusCapture = captureId(evaluation, "publisher:focus");

  // Act
  const composed = composeReport(run, [{ target, captures: [alignmentCapture, focusCapture, alignmentCapture] }]);
  const id = reportId(composed);
  await rm(target.repositoryRoot, { recursive: true, force: true });
  const json = run(["report", "show", id], { workingDirectory: root });
  const detail = run(["report", "show", id, "--reporter", "text"], { workingDirectory: root });
  const evidence = run(["report", "show", id, "--evidence", "1"], { workingDirectory: root });

  // Assert
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(`${report.note}\n`, composed.stdout);
  assert.ok(report.note.startsWith(`Verifier · 2 checks · 2 attributed findings · 1 failed check without a structured location\n\ngithub.com/example/workflows#895 · ${target.headCommit.slice(0, 7)} · FAIL\n`));
  assert.match(report.note, /tests\/workflow-step\.test\.ts:1\n {2}Judgment \[FAIL publisher:focus\]: Separate unrelated assertion outcomes\./);
  assert.match(report.note, /Judgment \[FAIL publisher:focus\]: Assert stale-edit rejection independently\./);
  assert.match(report.note, /FAIL publisher:alignment: Test alignment reported 2 violations\./);
  assert.match(report.note, /Next \[publisher:focus\]: Preserve the stale-edit and rescue sequence\./);
  assert.doesNotMatch(report.note, /10 direct expect|ordered AAA|Assertions should protect|\/project|PENDING/);
  assert.equal(report.groups[0].target.baseCommit, target.baseCommit);
  assert.equal(report.groups[0].target.headCommit, target.headCommit);
  assert.equal(report.groups[0].target.targetBranch, "main");
  assert.deepEqual(report.groups[0].checks.map(check => check.result), [alignment, JSON.parse(evaluation.stdout)[0]]);
  assert.deepEqual(report.groups[0].checks[1].result.citations, [citation]);
  assert.equal(report.groups[0].locations.length, 1);
  assert.equal(report.groups[0].locations[0].findings[0].capture, focusCapture);
  assert.equal(detail.status, 0, detail.stderr);
  assert.match(detail.stdout, /ordered AAA markers not recognized/);
  assert.match(detail.stdout, /Comment layout is not material to this judgment/);
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.equal(evidence.stdout, `${SOURCE_PATH}:1: 10 direct expect calls; expected exactly 1.  \r\n\r\n${SOURCE_PATH}:1: ordered AAA markers not recognized.\n`);
});

test("when a captured child revision is attributed to a different head, composition rejects it", async t => {
  // Arrange
  const { run, target } = await reportFixture(t);
  const automatic = run(["automatic", "--base", target.baseCommit, "--failures-only"]);
  const capture = captureId(automatic, "publisher:alignment");
  const parent = { ...target, headCommit: target.baseCommit };

  // Act
  const composed = composeReport(run, [{ target: parent, captures: [capture] }]);

  // Assert
  assert.equal(composed.status, 2);
  assert.equal(composed.stdout, "");
  assert.match(composed.stderr, /does not match the declared PR\/MR checkout and revisions/);
});

test("when the exact report file changes, retrieval never substitutes another report", async t => {
  // Arrange
  const { run, target, recordsDirectory } = await reportFixture(t);
  const automatic = run(["automatic", "--base", target.baseCommit, "--failures-only"]);
  const capture = captureId(automatic, "publisher:alignment");
  const id = reportId(composeReport(run, [{ target, captures: [capture] }]));
  const filename = join(recordsDirectory, `${id}.json`);
  const reportFile = await stat(filename);
  await writeFile(filename, '{"version":1,"kind":"report","groups":[]}');

  // Act
  const retrieved = run(["report", "show", id]);

  // Assert
  assert.equal(reportFile.mode & 0o777, 0o600);
  assert.equal(retrieved.status, 2);
  assert.equal(retrieved.stdout, "");
  assert.match(retrieved.stderr, /Exact findings record is missing, unsafe, or invalid/);
});

test("when findings storage is not private, check output remains available but reports cannot be read", async t => {
  // Arrange
  const { run, target, recordsDirectory } = await reportFixture(t);
  const automatic = run(["automatic", "--base", target.baseCommit, "--failures-only"]);
  const capture = captureId(automatic, "publisher:alignment");
  const id = reportId(composeReport(run, [{ target, captures: [capture] }]));
  await chmod(recordsDirectory, 0o755);

  // Act
  const retrieved = run(["report", "show", id]);
  const checked = run(["automatic", "--base", target.baseCommit, "--failures-only"]);

  // Assert
  assert.equal(retrieved.status, 2);
  assert.equal(retrieved.stdout, "");
  assert.match(retrieved.stderr, /Private Verifier findings storage is unavailable/);
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /findings capture unavailable/);
  assert.equal(JSON.parse(checked.stdout).find(result => result.id === "publisher:alignment").status, "FAIL");
});
