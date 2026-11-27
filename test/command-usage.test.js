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

test("usage separates bare status from typed and completed explicit status across projects", async t => {
  const { root, agentDir } = await usageFixture(t);
  const secondProject = join(root, "other-project");
  await mkdir(secondProject);
  const command = await loadVerifierCommand(agentDir, root);
  const menu = command.complete("");
  assert.deepEqual(menu.map(item => item.label), [
    "status", "checks", "verify", "timings", "demo", "uninstall", "generation", "closeout", "waive",
  ]);
  const [selection] = command.complete("sta");

  await command.invoke("   ");
  await command.invoke("status");
  await command.invoke(selection.value, { cwd: secondProject });
  const output = await command.invoke("status --usage", { cwd: secondProject });

  assert.match(output, /^Verifier command usage\nObservation period: \d{4}-\S+Z to \d{4}-\S+Z/m);
  assert.match(output, /^Bare \/verifier \(implicit status\): 1$/m);
  assert.match(output, /^status: 3$/m);
  for (const name of ["checks", "verify", "timings", "demo", "uninstall", "generation", "closeout", "waive"]) {
    assert.ok(output.split("\n").includes(`${name}: 0`));
  }
  assert.match(output, /0 = not observed in this period\./);
});

test("previewing completion, headless dispatch, direct CLI and automatic work do not start usage observation", async t => {
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);
  const options = {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
    },
  };

  command.complete("");
  command.complete("ver");
  await command.invoke("not-a-verifier-subcommand");
  await command.invoke("status", { hasUI: false, mode: "print" });
  await command.beforeAgentStart({ reason: "prompt", systemPrompt: [] }, { agentDir });
  await execute(process.execPath, [cli, "checks"], options);
  await execute(process.execPath, [cli, "automatic"], options);
  const output = await command.invoke("status --usage", { hasUI: false, mode: "print" });

  assert.match(output, /Observation has not begun/);
  await assert.rejects(stat(usageDir), { code: "ENOENT" });
});

test("a canceled waiver contributes an invocation without granting a waiver", async t => {
  const { root, agentDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);
  const sessionManager = { getSessionId: () => "private-session" };

  const notice = await command.invoke("waive private:gate --session", { sessionManager });
  const output = await command.invoke("status --usage");

  assert.equal(notice, "Verifier waiver not granted.");
  assert.match(output, /^waive: 1$/m);
});

test("only fixed aggregate fields are persisted even when a recognized invocation carries raw arguments", async t => {
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);

  await command.invoke("checks private-argument");

  const snapshot = JSON.parse(await readFile(join(usageDir, "counts.json"), "utf8"));
  assert.ok(Number.isSafeInteger(snapshot.startedAt));
  assert.deepEqual(snapshot, {
    version: 1,
    startedAt: snapshot.startedAt,
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

test("multiple OMP processes sharing the profile do not lose increments", async t => {
  const { agentDir, usageDir } = await usageFixture(t);
  const writeInProcess = `
    import createVerifierCommandUsage from ${JSON.stringify(usageModule)};
    const usage = createVerifierCommandUsage(["status"]);
    for (let count = 0; count < 8; count++) {
      if (!await usage.record(process.argv[1], "status")) {
        throw new Error("Expected invocation to be recorded");
      }
    }
  `;

  await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, [
    "--input-type=module", "--eval", writeInProcess, agentDir,
  ])));

  const snapshot = JSON.parse(await readFile(join(usageDir, "counts.json"), "utf8"));
  assert.deepEqual(snapshot.counts, {
    "implicit-status": 0,
    status: 32,
  });
});

test("an abandoned staging file does not change the observation period or leave extra history", async t => {
  const { agentDir, usageDir } = await usageFixture(t);
  const commandUsage = createVerifierCommandUsage(["status"]);
  await commandUsage.record(agentDir, "status");
  const path = join(usageDir, "counts.json");
  const { startedAt } = JSON.parse(await readFile(path, "utf8"));
  await writeFile(`${path}.next`, "incomplete write", { mode: 0o600 });

  await commandUsage.record(agentDir, "status");

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    startedAt,
    counts: {
      "implicit-status": 0,
      status: 2,
    },
  });
  assert.deepEqual((await readdir(usageDir)).sort(), ["counts.json", "lock"]);
});

test("unreadable usage counts cannot block the command or silently become zero", async t => {
  const { root, agentDir, usageDir } = await usageFixture(t);
  const command = await loadVerifierCommand(agentDir, root);
  await mkdir(usageDir, { mode: 0o700 });
  const countsPath = join(usageDir, "counts.json");
  await writeFile(countsPath, "invalid aggregate", { mode: 0o600 });

  const status = await command.invoke("status");
  const output = await command.invoke("status --usage");

  assert.match(status, /WATCHDOG\.md/);
  assert.match(output, /usage counts are unavailable/);
  assert.equal(await readFile(countsPath, "utf8"), "invalid aggregate");
});

test("a project-local agent directory does not accumulate command counts", async t => {
  const { root, agentDir, usageDir } = await usageFixture(t);
  await mkdir(join(root, ".git"));
  const commandUsage = createVerifierCommandUsage(["status"]);

  const recorded = await commandUsage.record(agentDir, "status");

  assert.equal(recorded, false);
  await assert.rejects(stat(usageDir), { code: "ENOENT" });
});
