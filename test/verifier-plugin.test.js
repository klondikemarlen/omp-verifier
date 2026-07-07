import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verifierPlugin from "../omp-plugin/index.js";

const OLD_WATCHDOG_ROSTER = `instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
  - name: default

  - name: Verifier
    tools: [read, grep, glob]
    instructions: |
      @~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md

      You are the always-on verifier for this session.
      Review completed code-change turns as untrusted until evidence proves them.
      Raise a blocker when work is called done without observed evidence.
      Raise a concern when checks are too broad, too narrow, or ignore local setup.
      Stay silent when the evidence is sufficient.

      Project-specific rules can live in downstream WATCHDOG files: setup commands,
      test commands, database/service details, browser routes, and "done means" checks.
`;

const registrations = { commands: new Map(), events: new Map(), notices: [] };
const pi = {
  setLabel(label) { registrations.label = label; },
  on(event, handler) { registrations.events.set(event, handler); },
  registerCommand(name, command) { registrations.commands.set(name, command); },
};
const ctx = { ui: { notify(message, level) { registrations.notices.push({ message, level }); } } };

verifierPlugin(pi);

assert.equal(registrations.label, "Verifier");
assert.deepEqual([...registrations.commands.keys()], ["verifier"]);
assert.deepEqual(registrations.commands.get("verifier").getArgumentCompletions("").map(item => item.label), ["install", "uninstall", "status"]);
assert.deepEqual(registrations.commands.get("verifier").getArgumentCompletions("un").map(item => item.label), ["uninstall"]);
assert.deepEqual(registrations.commands.get("verifier").getArgumentCompletions("install ").map(item => item.label), ["local", "global"]);
assert.deepEqual(registrations.commands.get("verifier").getArgumentCompletions("install g").map(item => item.label), ["global"]);
assert.deepEqual(registrations.commands.get("verifier").getArgumentCompletions("uninstall ").map(item => item.label), ["local", "global"]);
assert.equal(registrations.commands.get("verifier").getArgumentCompletions("install local "), null);
assert.ok(registrations.events.has("session_start"));

const statusRepo = await mkdtemp(join(tmpdir(), "omp-verifier-status-repo-"));
const statusAgentDir = await mkdtemp(join(tmpdir(), "omp-verifier-status-agent-"));
await writeFile(join(statusAgentDir, "config.yml"), "modelRoles:\n  advisor: openai/test:medium\nadvisor:\n  enabled: true\n");
await registrations.commands.get("verifier").handler("install", { ...ctx, cwd: statusRepo, agentDir: statusAgentDir });
await registrations.commands.get("verifier").handler("install global", { ...ctx, cwd: statusRepo, agentDir: statusAgentDir });
await registrations.commands.get("verifier").handler("status", { ...ctx, cwd: statusRepo, agentDir: statusAgentDir });
const statusMessage = registrations.notices.at(-1).message;
assert.match(statusMessage, /Verifier status:/);
assert.match(statusMessage, new RegExp(`active agent dir: ${statusAgentDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
assert.match(statusMessage, /global WATCHDOG\.yml: .* \(generated\)/);
assert.match(statusMessage, /global config\.yml: .* \(exists; advisor enabled; modelRoles\.advisor configured\)/);
assert.match(statusMessage, /project WATCHDOG\.yml: .* \(generated\)/);
assert.match(statusMessage, /project \.omp\/config\.yml: .* \(generated\)/);
assert.doesNotMatch(statusMessage, /--force|verify-pr|verify_pr_plan|boot_app_plan|format_pr_comment|verifier-bootstrap/);
await registrations.commands.get("verifier").handler("", { ...ctx, cwd: statusRepo, agentDir: statusAgentDir });
assert.match(registrations.notices.at(-1).message, /Verifier status:/);

const tempRepo = await mkdtemp(join(tmpdir(), "omp-verifier-"));
const configPath = join(tempRepo, ".omp", "config.yml");
const watchdogPath = join(tempRepo, "WATCHDOG.yml");

await registrations.commands.get("verifier").handler("install", { ...ctx, cwd: tempRepo });
assert.match(await readFile(configPath, "utf8"), /advisor:\n  enabled: true/);
const watchdog = await readFile(watchdogPath, "utf8");
assert.match(watchdog, /name: default/);
assert.doesNotMatch(watchdog, /name: Verifier/);
assert.match(watchdog, /@~\/.omp\/plugins\/node_modules\/omp-verifier\/WATCHDOG\.md/);
assert.doesNotMatch(watchdog, /model:/);
assert.match(registrations.notices.at(-1).message, /created/);

await writeFile(configPath, "custom: true\n");
await registrations.commands.get("verifier").handler("install", { ...ctx, cwd: tempRepo });
assert.equal(await readFile(configPath, "utf8"), "custom: true\n");
assert.match(await readFile(watchdogPath, "utf8"), /always-on verifier/);
assert.match(registrations.notices.at(-1).message, /kept existing .*config\.yml.*merge advisor keys manually/);
assert.match(registrations.notices.at(-1).message, /kept generated .*WATCHDOG\.yml/);


const oldRepo = await mkdtemp(join(tmpdir(), "omp-verifier-old-"));
const oldWatchdogPath = join(oldRepo, "WATCHDOG.yml");
await writeFile(oldWatchdogPath, OLD_WATCHDOG_ROSTER);
await registrations.commands.get("verifier").handler("install", { ...ctx, cwd: oldRepo });
assert.doesNotMatch(await readFile(oldWatchdogPath, "utf8"), /name: Verifier/);
assert.match(registrations.notices.at(-1).message, /replaced generated .*WATCHDOG\.yml/);
await writeFile(oldWatchdogPath, OLD_WATCHDOG_ROSTER);
await registrations.commands.get("verifier").handler("uninstall", { ...ctx, cwd: oldRepo });
assert.match(registrations.notices.at(-1).message, /removed .*WATCHDOG\.yml/);
await assert.rejects(readFile(oldWatchdogPath, "utf8"), /ENOENT/);
await registrations.commands.get("verifier").handler("uninstall", { ...ctx, cwd: tempRepo });
assert.match(registrations.notices.at(-1).message, /removed .*WATCHDOG\.yml/);
assert.match(registrations.notices.at(-1).message, /kept customized .*config\.yml/);
assert.equal(await readFile(configPath, "utf8"), "custom: true\n");

const cleanRepo = await mkdtemp(join(tmpdir(), "omp-verifier-clean-"));
await registrations.commands.get("verifier").handler("install local", { ...ctx, cwd: cleanRepo });
await registrations.commands.get("verifier").handler("uninstall local", { ...ctx, cwd: cleanRepo });
assert.match(registrations.notices.at(-1).message, /removed .*WATCHDOG\.yml/);
assert.match(registrations.notices.at(-1).message, /removed .*config\.yml/);

const customRepo = await mkdtemp(join(tmpdir(), "omp-verifier-custom-"));
await mkdir(join(customRepo, ".omp"));
await writeFile(join(customRepo, ".omp", "config.yml"), "custom: true\n");
await writeFile(join(customRepo, "WATCHDOG.yml"), "custom watchdog\n");
await registrations.commands.get("verifier").handler("install", { ...ctx, cwd: customRepo });
assert.match(registrations.notices.at(-1).message, /kept customized .*WATCHDOG\.yml.*merge verifier advisor manually/);
assert.equal(await readFile(join(customRepo, "WATCHDOG.yml"), "utf8"), "custom watchdog\n");
await registrations.commands.get("verifier").handler("status", { ...ctx, cwd: customRepo });
assert.match(registrations.notices.at(-1).message, /project WATCHDOG\.yml: .* \(customized\)/);

await registrations.commands.get("verifier").handler("uninstall", { ...ctx, cwd: customRepo });
assert.match(registrations.notices.at(-1).message, /kept customized .*WATCHDOG\.yml/);
assert.match(registrations.notices.at(-1).message, /kept customized .*config\.yml/);
assert.equal(await readFile(join(customRepo, "WATCHDOG.yml"), "utf8"), "custom watchdog\n");

await registrations.commands.get("verifier").handler("uninstall bogus", { ...ctx, cwd: customRepo });
assert.match(registrations.notices.at(-1).message, /Usage:/);

const globalRepo = await mkdtemp(join(tmpdir(), "omp-verifier-global-repo-"));
const agentDir = await mkdtemp(join(tmpdir(), "omp-verifier-agent-"));
const globalWatchdogPath = join(agentDir, "WATCHDOG.yml");
await registrations.commands.get("verifier").handler("install global", { ...ctx, cwd: globalRepo, agentDir });
assert.match(await readFile(globalWatchdogPath, "utf8"), /always-on verifier/);
assert.match(registrations.notices.at(-1).message, /created .*WATCHDOG\.yml/);
await assert.rejects(readFile(join(globalRepo, "WATCHDOG.yml"), "utf8"), /ENOENT/);
await assert.rejects(readFile(join(globalRepo, ".omp", "config.yml"), "utf8"), /ENOENT/);
await registrations.commands.get("verifier").handler("uninstall global", { ...ctx, cwd: globalRepo, agentDir });
assert.match(registrations.notices.at(-1).message, /removed .*WATCHDOG\.yml/);
await assert.rejects(readFile(globalWatchdogPath, "utf8"), /ENOENT/);

await writeFile(globalWatchdogPath, "custom global watchdog\n");
await registrations.commands.get("verifier").handler("install global", { ...ctx, cwd: globalRepo, agentDir });
assert.match(registrations.notices.at(-1).message, /kept customized .*WATCHDOG\.yml.*merge verifier advisor manually/);
assert.equal(await readFile(globalWatchdogPath, "utf8"), "custom global watchdog\n");
await registrations.commands.get("verifier").handler("status", { ...ctx, cwd: globalRepo, agentDir });
assert.match(registrations.notices.at(-1).message, /global WATCHDOG\.yml: .* \(customized\)/);

await registrations.commands.get("verifier").handler("uninstall global", { ...ctx, cwd: globalRepo, agentDir });
assert.match(registrations.notices.at(-1).message, /kept customized .*WATCHDOG\.yml/);
assert.equal(await readFile(globalWatchdogPath, "utf8"), "custom global watchdog\n");

await registrations.commands.get("verifier").handler("install local global", { ...ctx, cwd: globalRepo, agentDir });
assert.match(registrations.notices.at(-1).message, /Usage:/);

console.log("verifier advisor install/uninstall smoke test passed");
