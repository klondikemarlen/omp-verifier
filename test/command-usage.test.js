import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import createVerifierCommandUsage from "#root/omp-plugin/create-verifier-command-usage.js";

import verifierPlugin from "#root/omp-plugin/index.js";

const execute = promisify(execFile);
const cli = fileURLToPath(import.meta.resolve("#root/bin/omp-verifier.js"));
const usageModule = import.meta.resolve("#root/omp-plugin/create-verifier-command-usage.js");

async function usageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-command-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const verifierDir = join(agentDir, "verifier");
  await mkdir(verifierDir, { recursive: true, mode: 0o700 });
  return {
    root,
    agentDir,
    usageDir: join(verifierDir, "command-usage"),
  };
}

async function loadVerifierCommand(agentDir, cwd) {
  const commands = new Map();
  const events = new Map();
  await verifierPlugin({
    pi: { getAgentDir: () => agentDir },
    setLabel() {},
    on(event, handler) { events.set(event, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerMessageRenderer() {},
  });
  const command = commands.get("verifier");

  return {
    complete: command.getArgumentCompletions,
    beforeAgentStart: events.get("before_agent_start"),
    async invoke(args, context = {}, confirm = () => false) {
      const notices = [];
      await command.handler(args, {
        cwd,
        hasUI: true,
        mode: "tui",
        ui: {
          notify(message) { notices.push(message); },
          confirm,
        },
        ...context,
      });
      return notices.at(-1);
    },
  };
}

function runCli(root, agentDir, ...args) {
  return execute(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
    },
  });
}

test("when completing a verifier subcommand, offers the existing nine options", async t => {
  // Arrange
  const { root, agentDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);

  // Act
  const menu = command.complete("");

  // Assert
  assert.deepEqual(menu.map(item => item.label), [
    "status", "checks", "verify", "timings", "demo", "uninstall", "generation", "closeout", "waive",
  ]);
});

test("when status is submitted across projects, reports explicit and implicit invocations separately", async t => {
  // Arrange
  const { root, agentDir } = await usageFixture(t);
  const secondProject = join(root, "other-project");
  await mkdir(secondProject);
  const command = await loadVerifierCommand(agentDir, root);
  const [selection] = command.complete("sta");
  let clock = 1_700_000_000_000;
  t.mock.method(Date, "now", () => clock);
  await command.invoke("   ");
  await command.invoke("status");
  await command.invoke(selection.value, { cwd: secondProject });
  clock += 60_000;

  // Act
  const output = await command.invoke("status --usage", { cwd: secondProject });

  // Assert
  assert.equal(output, [
    "Verifier command usage",
    "Observation period: 2023-11-14T22:13:20.000Z to 2023-11-14T22:14:20.000Z",
    "Recorded invocations across projects in this OMP profile (not outcomes).",
    "",
    "Bare /verifier (implicit status): 1",
    "status: 3",
    "checks: 0",
    "verify: 0",
    "timings: 0",
    "demo: 0",
    "uninstall: 0",
    "generation: 0",
    "closeout: 0",
    "waive: 0",
    "",
    "0 = not observed in this period. Status includes uses of this report.",
  ].join("\n"));
});

test("when the completion menu is previewed without submission, leaves usage observation unstarted", async t => {
  // Arrange
  const { root, agentDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);

  // Act
  command.complete("");
  command.complete("ver");
  const output = await command.invoke("status --usage", { hasUI: false, mode: "print" });

  // Assert
  assert.equal(output, "Verifier command usage\nObservation has not begun; no interactive invocations have been recorded.");
});

test("when an unknown subcommand is submitted, does not create usage storage", async t => {
  // Arrange
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);

  // Act
  await command.invoke("not-a-verifier-subcommand");

  // Assert
  await assert.rejects(stat(usageDir), {
    code: "ENOENT",
  });
});

test("when status is invoked without an interactive UI, does not create usage storage", async t => {
  // Arrange
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);

  // Act
  await command.invoke("status", { hasUI: false, mode: "print" });

  // Assert
  await assert.rejects(stat(usageDir), {
    code: "ENOENT",
  });
});

test("when automatic advisor work starts, does not create usage storage", async t => {
  // Arrange
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);

  // Act
  await command.beforeAgentStart({ reason: "prompt", systemPrompt: [] }, { agentDir });
  await runCli(root, agentDir, "automatic");

  // Assert
  await assert.rejects(stat(usageDir), {
    code: "ENOENT",
  });
});

test("when checks are listed through the direct CLI, does not create usage storage", async t => {
  // Arrange
  const { root, agentDir, usageDir } = await usageFixture(t);

  // Act
  await runCli(root, agentDir, "checks");

  // Assert
  await assert.rejects(stat(usageDir), {
    code: "ENOENT",
  });
});

test("when a user cancels a waiver, counts the invocation in the usage report", async t => {
  // Arrange
  const { root, agentDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);
  const sessionManager = { getSessionId: () => "private-session" };
  const declineWaiver = () => false;

  // Act
  await command.invoke("waive private:gate --session", { sessionManager }, declineWaiver);
  const output = await command.invoke("status --usage");

  // Assert
  assert.match(output, /^waive: 1$/m);
});

test("when a user cancels a waiver, reports that no waiver was granted", async t => {
  // Arrange
  const { root, agentDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);
  const sessionManager = { getSessionId: () => "private-session" };
  const declineWaiver = () => false;

  // Act
  const notice = await command.invoke("waive private:gate --session", { sessionManager }, declineWaiver);

  // Assert
  assert.equal(notice, "Verifier waiver not granted.");
});

test("when a recognized invocation carries raw arguments, persists only the fixed aggregate fields", async t => {
  // Arrange
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);
  t.mock.method(Date, "now", () => 1_700_000_000_000);

  // Act
  await command.invoke("checks private-argument");

  // Assert
  const snapshot = JSON.parse(await readFile(join(usageDir, "counts.json"), "utf8"));
  assert.deepEqual(snapshot, {
    version: 1,
    startedAt: 1_700_000_000_000,
    counts: {
      "implicit-status": 0,
      status: 0,
      checks: 1,
      verify: 0,
      timings: 0,
      demo: 0,
      uninstall: 0,
      generation: 0,
      closeout: 0,
      waive: 0,
    },
  });
});

test("when multiple processes share a profile, preserves every increment", async t => {
  // Arrange
  const { agentDir, usageDir } = await usageFixture(t);
  const writeInProcess = `
    import createVerifierCommandUsage from ${JSON.stringify(usageModule)};
    const usage = createVerifierCommandUsage(["status"]);
    for (let count = 0; count < 8; count++) {
      await usage.record(process.argv[1], "status");
    }
  `;

  // Act
  await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, [
    "--input-type=module", "--eval", writeInProcess, agentDir,
  ])));

  // Assert
  const snapshot = JSON.parse(await readFile(join(usageDir, "counts.json"), "utf8"));
  assert.deepEqual(snapshot.counts, {
    "implicit-status": 0,
    status: 32,
  });
});

test("when a write leaves a staging file behind, increments the last committed aggregate", async t => {
  // Arrange
  const { agentDir, usageDir } = await usageFixture(t);
  const commandUsage = createVerifierCommandUsage(["status"]);
  const path = join(usageDir, "counts.json");
  const committedSnapshot = {
    version: 1,
    startedAt: 1_700_000_000_000,
    counts: {
      "implicit-status": 0,
      status: 1,
    },
  };
  await mkdir(usageDir, { mode: 0o700 });
  await writeFile(path, JSON.stringify(committedSnapshot), { mode: 0o600 });
  await writeFile(`${path}.next`, "incomplete write", { mode: 0o600 });

  // Act
  await commandUsage.record(agentDir, "status");

  // Assert
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(snapshot, {
    version: 1,
    startedAt: 1_700_000_000_000,
    counts: {
      "implicit-status": 0,
      status: 2,
    },
  });
});

test("when recovering from an incomplete write, leaves no staged history behind", async t => {
  // Arrange
  const { agentDir, usageDir } = await usageFixture(t);
  const commandUsage = createVerifierCommandUsage(["status"]);
  await mkdir(usageDir, { mode: 0o700 });
  await writeFile(join(usageDir, "counts.json.next"), "incomplete first write", { mode: 0o600 });

  // Act
  await commandUsage.record(agentDir, "status");

  // Assert
  assert.deepEqual((await readdir(usageDir)).sort(), ["counts.json", "lock"]);
});

test("when usage storage is unreadable, still reports the normal verifier status", async t => {
  // Arrange
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);
  await mkdir(usageDir, { mode: 0o700 });
  await writeFile(join(usageDir, "counts.json"), "invalid aggregate", { mode: 0o600 });

  // Act
  const status = await command.invoke("status");

  // Assert
  assert.match(status, /WATCHDOG\.md/);
});

test("when stored counts are unreadable, reports unavailable rather than zero", async t => {
  // Arrange
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);
  await mkdir(usageDir, { mode: 0o700 });
  await writeFile(join(usageDir, "counts.json"), "invalid aggregate", { mode: 0o600 });

  // Act
  const output = await command.invoke("status --usage");

  // Assert
  assert.equal(output, "Verifier command usage\nLocal usage counts are unavailable.");
});

test("when the aggregate is unreadable, preserves the original data", async t => {
  // Arrange
  const { agentDir, usageDir } = await usageFixture(t);
  const commandUsage = createVerifierCommandUsage(["status"]);
  const countsPath = join(usageDir, "counts.json");
  await mkdir(usageDir, { mode: 0o700 });
  await writeFile(countsPath, "invalid aggregate", { mode: 0o600 });

  // Act
  await commandUsage.record(agentDir, "status");

  // Assert
  assert.equal(await readFile(countsPath, "utf8"), "invalid aggregate");
});

test("when the agent directory is inside a checkout, does not create usage storage", async t => {
  // Arrange
  const { root, agentDir, usageDir } = await usageFixture(t);
  await mkdir(join(root, ".git"));
  const commandUsage = createVerifierCommandUsage(["status"]);

  // Act
  await commandUsage.record(agentDir, "status");

  // Assert
  await assert.rejects(stat(usageDir), {
    code: "ENOENT",
  });
});
