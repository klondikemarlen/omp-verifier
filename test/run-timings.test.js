import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { installRuntime, runtimePaths } from "#root/omp-plugin/runtime-generations.js";

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

async function waitForCheckStart(path, signal) {
  for (;;) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await delay(10, undefined, {
      signal,
    });
  }
}

function killProcessGroup(pid) {
  if (!pid) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

function assertStartedCheck(check, id, timeoutMs, runStartedAt) {
  const { startedAt, ...observation } = check;
  assert.ok(Number.isSafeInteger(startedAt));
  assert.ok(startedAt >= runStartedAt);
  assert.deepEqual(observation, {
    id,
    status: "STARTED",
    durationMs: null,
    timeoutMs,
  });
}

async function readTimingsAfterFastCheck({ agentDirectory, run }, checkId, signal) {
  // Filesystem notifications wake the CLI reader; only its output proves progress.
  const watcher = watch(agentDirectory, {
    recursive: true,
  });
  const changes = on(watcher, "change", {
    signal,
    close: ["close"],
  });
  try {
    for (;;) {
      const report = run("timings", "--reporter", "json");
      assert.equal(report.status, 0, report.stderr);
      const records = JSON.parse(report.stdout);
      if (records[0]?.checks.some(check => check.id === checkId && check.status === "PASS")) {
        return records;
      }

      const { done } = await changes.next();
      assert.ok(!done, "Timing observation stopped before fast check completed");
    }
  } finally {
    watcher.close();
  }
}

async function interruptInstalledRun(fixture, signal) {
  const { cwd, agentDirectory, provider, env, installChecks } = fixture;
  const checkId = "publisher:slow";
  const readyFile = "slow-check-started";
  await installChecks([{
    id: checkId,
    label: "Slow check",
    description: "Waits for the test to interrupt verification.",
    entry: "./slow.mjs",
    timeoutMs: 40_000,
  }]);
  await writeFile(join(provider, "slow.mjs"), `
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

await delay(150);
await writeFile(${JSON.stringify(readyFile)}, "");
await delay(30_000);
`);
  await installRuntime(agentDirectory);
  const { launcher } = runtimePaths(agentDirectory);
  const child = spawn(process.execPath, [launcher, "verify", checkId], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", chunk => {
    stdout += chunk;
  });
  const timeout = AbortSignal.timeout(20_000);
  const completion = once(child, "close", {
    signal: timeout,
  });
  const readiness = new AbortController();
  try {
    await Promise.race([
      waitForCheckStart(join(cwd, readyFile), readiness.signal),
      completion.then(([code, exitSignal]) => {
        assert.fail(`Launcher exited before the check started: ${code ?? exitSignal}`);
      }),
    ]);

    // Killing only the launcher could leave the coordinator running without a signal.
    if (signal === "SIGKILL") {
      killProcessGroup(child.pid);
    } else {
      assert.ok(child.kill(signal));
    }

    const [code, exitSignal] = await completion;
    assert.equal(code, null);
    assert.equal(exitSignal, signal);
    assert.equal(stdout, "");
  } finally {
    readiness.abort();
    killProcessGroup(child.pid);
  }
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
    assert.ok(!Object.hasOwn(run, "cancelledAfterMs"));
    assert.ok(!Object.hasOwn(run, "cancellationSignal"));
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

test("when a fast verify check finishes while another is gated, a separate timings reader sees both states on the same run", async t => {
  // Arrange
  const fixture = await timingFixture(t);
  const { cwd, env, provider, installChecks, run } = fixture;
  const socketPath = join(cwd, "check.sock");
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(socketPath);
  t.after(() => server.close());
  await listening;

  const fastId = "publisher:fast";
  const slowId = "publisher:gated";
  const fastTimeoutMs = 10_000;
  const slowTimeoutMs = 40_000;
  await installChecks([
    {
      id: fastId,
      label: "Fast check",
      description: "Passes without waiting for the gate.",
      entry: "./fast.mjs",
      timeoutMs: fastTimeoutMs,
    },
    {
      id: slowId,
      label: "Gated check",
      description: "Waits for the observer to release the gate.",
      entry: "./gated.mjs",
      timeoutMs: slowTimeoutMs,
    },
  ]);
  await writeFile(join(provider, "fast.mjs"), `
process.stdout.write(JSON.stringify({
  status: "PASS",
  summary: "Fast check passed.",
}));
`);
  await writeFile(join(provider, "gated.mjs"), `
import { once } from "node:events";
import { createConnection } from "node:net";

const gate = createConnection(${JSON.stringify(socketPath)});
await once(gate, "end");
process.stdout.write(JSON.stringify({
  status: "PASS",
  summary: "Gated check passed.",
}));
`);

  // Act
  const timeout = AbortSignal.timeout(20_000);
  const connected = once(server, "connection", {
    signal: timeout,
  });
  const beforeRun = Date.now();
  const child = spawn(process.execPath, [cliPath, "verify", fastId, slowId], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", chunk => {
    stdout += chunk;
  });
  const completion = once(child, "close", {
    signal: timeout,
  });
  const prematureExit = completion.then(([code, exitSignal]) => {
    assert.fail(`Verification exited before the gate opened: ${code ?? exitSignal}`);
  });
  let gate;
  try {
    [gate] = await Promise.race([connected, prematureExit]);
    const inProgress = await readTimingsAfterFastCheck(fixture, fastId, timeout);

    // Assert
    assert.equal(inProgress.length, 1);
    const [activeRun] = inProgress;
    assert.ok(activeRun.startedAt >= beforeRun);
    assert.equal(activeRun.coordinatorMs, null);
    assert.equal(activeRun.fullRunMs, null);
    assert.equal(activeRun.checks.length, 2);
    const fast = activeRun.checks.find(check => check.id === fastId);
    const slow = activeRun.checks.find(check => check.id === slowId);
    assert.equal(fast.status, "PASS");
    assert.ok(Number.isSafeInteger(fast.startedAt));
    assert.ok(fast.startedAt >= activeRun.startedAt);
    assert.ok(fast.durationMs > 0);
    assert.equal(fast.timeoutMs, fastTimeoutMs);
    assert.ok(!Object.hasOwn(fast, "timedOut"));
    assertStartedCheck(slow, slowId, slowTimeoutMs, activeRun.startedAt);
    assert.equal(stdout, "");

    // Release the check and read the same run again after the verdict.
    gate.end();
    const [code, exitSignal] = await completion;
    assert.equal(code, 0, stdout);
    assert.equal(exitSignal, null);
    assert.deepEqual(JSON.parse(stdout), [
      {
        id: fastId,
        status: "PASS",
        summary: "Fast check passed.",
      },
      {
        id: slowId,
        status: "PASS",
        summary: "Gated check passed.",
      },
    ]);
    const report = run("timings", "--reporter", "json");
    assert.equal(report.status, 0, report.stderr);
    const finished = JSON.parse(report.stdout);
    assert.equal(finished.length, 1);
    const [finishedRun] = finished;
    assert.equal(finishedRun.id, activeRun.id);
    assert.equal(finishedRun.startedAt, activeRun.startedAt);
    assert.equal(finishedRun.checks.length, 2);
    assert.deepEqual(finishedRun.checks.find(check => check.id === fastId), fast);
    const finishedSlow = finishedRun.checks.find(check => check.id === slowId);
    assert.deepEqual(finishedSlow, {
      ...slow,
      status: "PASS",
      durationMs: finishedSlow.durationMs,
    });
    assert.ok(finishedSlow.durationMs > 0);
    assert.ok(finishedRun.coordinatorMs >= finishedSlow.durationMs);
    assert.equal(finishedRun.fullRunMs, finishedRun.coordinatorMs);
  } finally {
    gate?.destroy();
    killProcessGroup(child.pid);
  }
});

test("when a check exhausts its execution budget, timings records an observed timeout without changing the verdict", async t => {
  // Arrange
  const { provider, installChecks, run } = await timingFixture(t);
  const id = "publisher:timeout";
  const timeoutMs = 500;
  await installChecks([{
    id,
    label: "Timeout check",
    description: "Cannot finish before the verifier's budget expires.",
    entry: "./timeout.mjs",
    timeoutMs,
  }]);
  await writeFile(join(provider, "timeout.mjs"), `
import { setTimeout as delay } from "node:timers/promises";

await delay(30_000);
`);

  // Act
  const verified = run("verify", id);
  const report = run("timings", "--reporter", "json");

  // Assert
  assert.equal(verified.status, 1, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), [{
    id,
    status: "BLOCKED",
    summary: "Verification timed out",
  }]);
  assert.equal(report.status, 0, report.stderr);
  const [record] = JSON.parse(report.stdout);
  assert.equal(record.checks.length, 1);
  const [{ startedAt, durationMs, ...observation }] = record.checks;
  assert.deepEqual(observation, {
    id,
    status: "BLOCKED",
    timeoutMs,
    timedOut: true,
  });
  assert.ok(Number.isSafeInteger(startedAt));
  assert.ok(startedAt >= record.startedAt);
  assert.ok(durationMs > 0);
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

test("when the installed launcher receives SIGTERM, history reports observed cancellation without a verdict", async t => {
  // Arrange
  const fixture = await timingFixture(t);

  // Act
  await interruptInstalledRun(fixture, "SIGTERM");
  const json = fixture.run("timings", "--reporter", "json");
  const text = fixture.run("timings", "--reporter", "text");

  // Assert
  assert.equal(json.status, 0, json.stderr);
  assert.equal(text.status, 0, text.stderr);
  const runs = JSON.parse(json.stdout);
  assert.equal(runs.length, 1);
  const [record] = runs;
  assert.equal(record.command, "verify");
  assert.equal(record.cancellationSignal, "SIGTERM");
  assert.ok(Number.isSafeInteger(record.cancelledAfterMs));
  assert.ok(record.cancelledAfterMs >= 100);
  assert.equal(record.coordinatorMs, null);
  assert.equal(record.fullRunMs, null);
  assert.equal(record.checks.length, 1);
  assertStartedCheck(record.checks[0], "publisher:slow", 40_000, record.startedAt);
  assert.match(text.stdout, /Cancelled after \d[^\n]* \(SIGTERM\); full run unknown\./);
  assert.doesNotMatch(text.stdout, /Coordinator finish not observed/);
});

test("when SIGKILL leaves no cancellation witness, history keeps the finish unknown", async t => {
  // Arrange
  const fixture = await timingFixture(t);

  // Act
  await interruptInstalledRun(fixture, "SIGKILL");
  const json = fixture.run("timings", "--reporter", "json");
  const text = fixture.run("timings", "--reporter", "text");

  // Assert
  assert.equal(json.status, 0, json.stderr);
  assert.equal(text.status, 0, text.stderr);
  const runs = JSON.parse(json.stdout);
  assert.equal(runs.length, 1);
  const [record] = runs;
  assert.equal(record.command, "verify");
  assert.ok(!Object.hasOwn(record, "cancellationSignal"));
  assert.ok(!Object.hasOwn(record, "cancelledAfterMs"));
  assert.equal(record.coordinatorMs, null);
  assert.equal(record.fullRunMs, null);
  assert.equal(record.checks.length, 1);
  assertStartedCheck(record.checks[0], "publisher:slow", 40_000, record.startedAt);
  assert.match(text.stdout, /Coordinator finish not observed; full run unknown\./);
  assert.doesNotMatch(text.stdout, /Cancelled after/);

  fixture.useTimingStore();
  t.mock.timers.enable({
    apis: ["Date"],
    now: record.checks[0].startedAt + record.checks[0].timeoutMs + 1,
  });
  const [later] = await readTimingHistory(fixture.cwd);
  assert.deepEqual(later, record);
});

test("when cancellation is immediate, history preserves zero elapsed milliseconds", async t => {
  // Arrange
  const { cwd, useTimingStore } = await timingFixture(t);
  useTimingStore();

  // Act
  await saveTimingRun(cwd, {
    id: randomUUID(),
    command: "verify",
    startedAt: 1,
    coordinatorMs: null,
    generation: null,
    checks: [],
    cancelledAfterMs: 0,
    cancellationSignal: "SIGINT",
  });

  // Assert
  const [record] = await readTimingHistory(cwd);
  assert.equal(record.cancelledAfterMs, 0);
  assert.equal(record.cancellationSignal, "SIGINT");
  assert.equal(record.fullRunMs, null);
});

test("when cancellation metadata is incomplete or contradictory, history rejects the observation", async t => {
  // Arrange
  const { cwd, useTimingStore } = await timingFixture(t);
  useTimingStore();
  const startedRun = {
    id: randomUUID(),
    command: "verify",
    startedAt: 1,
    coordinatorMs: null,
    generation: null,
    checks: [],
  };
  const invalidObservations = [
    {
      cancelledAfterMs: 12,
    },
    {
      cancellationSignal: "SIGTERM",
    },
    {
      cancelledAfterMs: 12,
      cancellationSignal: "SIGKILL",
    },
    {
      cancelledAfterMs: -1,
      cancellationSignal: "SIGTERM",
    },
    {
      cancelledAfterMs: 1.5,
      cancellationSignal: "SIGTERM",
    },
    {
      cancelledAfterMs: null,
      cancellationSignal: "SIGTERM",
    },
    {
      cancelledAfterMs: 12,
      cancellationSignal: "SIGTERM",
      coordinatorMs: 15,
    },
  ];

  // Act and Assert
  for (const observation of invalidObservations) {
    await assert.rejects(saveTimingRun(cwd, {
      ...startedRun,
      ...observation,
    }), /Invalid verifier timing cancellation/, JSON.stringify(observation));
  }
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
