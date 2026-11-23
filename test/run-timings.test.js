import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readTimingHistory, saveTimingAssessment, saveTimingRun } from "#root/omp-plugin/timing-history.js";

const cliPath = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));

async function timingFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-run-timings-"));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
  }));
  const cwd = join(root, "checkout");
  const agentDirectory = join(root, "agent");
  const packageDirectory = join(root, "plugins", "node_modules");
  const provider = join(packageDirectory, "publisher");
  await mkdir(cwd);
  await mkdir(provider, {
    recursive: true,
  });
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    PI_CODING_AGENT_DIR: agentDirectory,
    OMP_VERIFIER_PACKAGE_DIRECTORY: packageDirectory,
  };

  async function installChecks(verifications) {
    await writeFile(join(provider, "package.json"), JSON.stringify({
      name: "publisher",
      omp: {
        extensions: ["./index.js"],
        verifications,
      },
    }));
  }

  function run(...args) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  function useTimingStore() {
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
    t.after(() => {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
      }
    });
  }

  return {
    cwd,
    agentDirectory,
    provider,
    env,
    installChecks,
    run,
    useTimingStore,
  };
}

test("when source changes between verify and automatic, history retains both outcomes without storing private input or output", async t => {
  // Arrange
  const { cwd, agentDirectory, provider, env, installChecks, run } = await timingFixture(t);
  const checkId = "publisher:source";
  const sourcePath = "private-source.fixture";
  await installChecks([{
    id: checkId,
    label: "Source check",
    description: "Reports whether the source fixture was corrected.",
    entry: "./private-command.mjs",
    pathTriggers: [sourcePath],
  }]);
  await writeFile(join(provider, "private-command.mjs"), `
import { appendFile, readFile } from "node:fs/promises";

const source = await readFile(${JSON.stringify(sourcePath)}, "utf8");
const isCorrected = source === "private-source-after";
await appendFile("invocations", ".");
const result = {
  status: isCorrected ? "PASS" : "FAIL",
  summary: "private-summary",
  evidence: source,
  nextCheck: "private-next-check",
};
process.stdout.write(JSON.stringify(result));
process.exitCode = isCorrected ? 0 : 1;
`);
  execFileSync("git", ["init", "--quiet"], {
    cwd,
    env,
  });
  await writeFile(join(cwd, sourcePath), "private-source-before");

  // Act
  const failed = run("verify", checkId);
  await writeFile(join(cwd, sourcePath), "private-source-after");
  const corrected = run("automatic", sourcePath, "--reporter", "text", "--failures-only");
  const report = run("timings", "--reporter", "json");
  const invocations = await readFile(join(cwd, "invocations"), "utf8");
  const storedEntries = await readdir(agentDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  const storedContent = await Promise.all(storedEntries.filter(entry => entry.isFile()).map(entry =>
    readFile(join(entry.parentPath, entry.name), "utf8"),
  ));

  // Assert
  assert.equal(failed.status, 1, failed.stderr);
  assert.deepEqual(JSON.parse(failed.stdout), [{
    id: checkId,
    status: "FAIL",
    summary: "private-summary",
    evidence: "private-source-before",
    nextCheck: "private-next-check",
  }]);
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(corrected.stdout, "");
  assert.equal(report.status, 0, report.stderr);
  assert.equal(invocations, "..");
  assert.ok(storedContent.length > 0);
  const privateData = /private-source|private-summary|private-next-check|private-command/;
  assert.doesNotMatch(report.stdout, privateData);
  assert.doesNotMatch(storedContent.join("\n"), privateData);
  assert.ok(!storedContent.join("\n").includes(cwd));

  const runs = JSON.parse(report.stdout);
  assert.deepEqual(runs.map(run => run.command), ["automatic", "verify"]);
  const [newer, older] = runs;
  assert.notEqual(newer.id, older.id);
  assert.ok(Number.isSafeInteger(newer.startedAt));
  assert.ok(Number.isSafeInteger(older.startedAt));
  assert.ok(newer.startedAt >= older.startedAt);
  assert.deepEqual(newer.checks.map(check => [check.id, check.status]), [[checkId, "PASS"]]);
  assert.deepEqual(older.checks.map(check => [check.id, check.status]), [[checkId, "FAIL"]]);
  for (const run of runs) {
    assert.ok(run.checks[0].durationMs > 0);
    assert.ok(run.coordinatorMs >= run.checks[0].durationMs);
    assert.equal(run.fullRunMs, run.coordinatorMs);
  }
});

test("when two verify checks overlap, wall time contains each check without adding their durations", async t => {
  // Arrange
  const { provider, installChecks, run } = await timingFixture(t);
  const checks = ["first", "second"].map(name => ({
    id: `publisher:${name}`,
    label: name,
    description: "Synchronizes with the peer check before passing.",
    entry: `./${name}.mjs`,
    timeoutMs: 12_000,
  }));
  await installChecks(checks);
  for (const [name, peer] of [["first", "second"], ["second", "first"]]) {
    await writeFile(join(provider, `${name}.mjs`), `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

writeFileSync(${JSON.stringify(name)}, "ready");
while (!existsSync(${JSON.stringify(peer)})) {
  await delay(10);
}
// Hold a common interval after both checks are running, rather than assuming
// the two subprocesses will be scheduled within a fixed startup window.
await delay(750);
process.stdout.write(JSON.stringify({
  status: "PASS",
  summary: "Both checks reached the barrier.",
}));
`);
  }

  // Act
  const verified = run("verify", "publisher:first", "publisher:second");
  const report = run("timings", "--reporter", "json");

  // Assert
  assert.equal(verified.status, 0, verified.stdout || verified.stderr);
  assert.equal(report.status, 0, report.stderr);
  const [record] = JSON.parse(report.stdout);
  assert.deepEqual(record.checks.map(check => check.id).sort(), ["publisher:first", "publisher:second"]);
  assert.deepEqual(record.checks.map(check => check.status), ["PASS", "PASS"]);
  const durations = record.checks.map(check => check.durationMs);
  assert.ok(durations.every(duration => duration > 0));
  assert.ok(record.coordinatorMs >= Math.max(...durations));
  assert.ok(record.coordinatorMs < durations[0] + durations[1]);
  assert.equal(record.fullRunMs, record.coordinatorMs);
});

test("when no automatic check is selected and a manual ID is unknown, history shows no invented check runtime", async t => {
  // Arrange
  const { run } = await timingFixture(t);
  const unknownId = "publisher:private-selector";

  // Act
  const empty = run("automatic", "--reporter", "text", "--failures-only");
  const unknown = run("verify", unknownId);
  const report = run("timings", "--reporter", "json");

  // Assert
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "");
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.deepEqual(JSON.parse(unknown.stdout), [{
    id: unknownId,
    status: "BLOCKED",
    summary: "Verification check is not installed",
  }]);
  assert.equal(report.status, 0, report.stderr);
  const runs = JSON.parse(report.stdout);
  assert.deepEqual(runs.map(run => run.command), ["verify", "automatic"]);
  const [blocked, unselected] = runs;
  assert.deepEqual(blocked.checks, [{
    id: "unidentified",
    status: "BLOCKED",
    durationMs: null,
  }]);
  assert.deepEqual(unselected.checks, []);
});

test("when more than ten runs exist, the CLI defaults to the ten newest in the current checkout", async t => {
  // Arrange
  const { cwd, agentDirectory, run, useTimingStore } = await timingFixture(t);
  useTimingStore();
  await mkdir(agentDirectory);
  const ids = [];
  for (let startedAt = 1; startedAt <= 11; startedAt += 1) {
    const id = randomUUID();
    ids.push(id);
    await saveTimingRun(cwd, {
      id,
      command: "verify",
      startedAt,
      coordinatorMs: 5,
      generation: null,
      checks: [],
    });
  }
  await saveTimingRun(agentDirectory, {
    id: randomUUID(),
    command: "verify",
    startedAt: 12,
    coordinatorMs: 5,
    generation: null,
    checks: [],
  });

  // Act
  const report = run("timings", "--reporter", "json");
  const limited = run("timings", "--reporter", "json", "--limit", "1");

  // Assert
  assert.equal(report.status, 0, report.stderr);
  assert.deepEqual(JSON.parse(report.stdout).map(record => record.id), ids.slice(1).reverse());
  assert.equal(limited.status, 0, limited.stderr);
  assert.deepEqual(JSON.parse(limited.stdout).map(record => record.id), [ids.at(-1)]);
});

test("when a semantic check is pending, only its matching terminal assessment completes the run", async t => {
  // Arrange
  const { cwd, useTimingStore } = await timingFixture(t);
  useTimingStore();
  const requestId = randomUUID();
  const startedAt = 1_000;
  await saveTimingRun(cwd, {
    id: randomUUID(),
    command: "verify",
    startedAt,
    coordinatorMs: 20,
    generation: null,
    checks: [{
      id: "publisher:semantic",
      status: "PENDING",
      durationMs: 15,
      requestId,
    }],
  });

  // Act
  await saveTimingAssessment({
    requestId: randomUUID(),
    status: "PASS",
    completedAt: startedAt + 100,
  });
  const [pending] = await readTimingHistory(cwd);
  await saveTimingAssessment({
    requestId,
    status: "FAIL",
    completedAt: startedAt + 200,
  });
  const [finished] = await readTimingHistory(cwd);

  // Assert
  assert.equal(pending.fullRunMs, null);
  assert.equal(pending.checks[0].finalStatus, undefined);
  assert.equal(finished.coordinatorMs, 20);
  assert.equal(finished.fullRunMs, 200);
  assert.equal(finished.checks[0].status, "PENDING");
  assert.equal(finished.checks[0].durationMs, 15);
  assert.equal(finished.checks[0].finalStatus, "FAIL");
});
