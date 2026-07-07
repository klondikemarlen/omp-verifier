import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verifierPlugin from "../omp-plugin/index.js";

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
assert.deepEqual(registrations.commands.get("verifier").getArgumentCompletions("").map(item => item.label), ["install", "uninstall", "info"]);
assert.deepEqual(registrations.commands.get("verifier").getArgumentCompletions("un").map(item => item.label), ["uninstall"]);
assert.equal(registrations.commands.get("verifier").getArgumentCompletions("install "), null);
assert.ok(registrations.events.has("session_start"));

await registrations.commands.get("verifier").handler("info", ctx);
assert.match(registrations.notices.at(-1).message, /verifier install \[local\|global\] \| \/verifier uninstall \[local\|global\] \[--force\]/);
assert.doesNotMatch(registrations.notices.at(-1).message, /verify-pr|verify_pr_plan|boot_app_plan|format_pr_comment|verifier-bootstrap/);

const tempRepo = await mkdtemp(join(tmpdir(), "omp-verifier-"));
const configPath = join(tempRepo, ".omp", "config.yml");
const watchdogPath = join(tempRepo, "WATCHDOG.yml");

await registrations.commands.get("verifier").handler("install", { ...ctx, cwd: tempRepo });
assert.match(await readFile(configPath, "utf8"), /advisor:\n  enabled: true/);
const watchdog = await readFile(watchdogPath, "utf8");
assert.match(watchdog, /name: default/);
assert.match(watchdog, /@~\/.omp\/plugins\/node_modules\/omp-verifier\/WATCHDOG\.md/);
assert.doesNotMatch(watchdog, /model:/);
assert.match(registrations.notices.at(-1).message, /created/);

await writeFile(configPath, "custom: true\n");
await registrations.commands.get("verifier").handler("install", { ...ctx, cwd: tempRepo });
assert.equal(await readFile(configPath, "utf8"), "custom: true\n");
assert.match(await readFile(watchdogPath, "utf8"), /always-on verifier/);
assert.match(registrations.notices.at(-1).message, /kept existing .*config\.yml.*merge advisor keys manually/);
assert.match(registrations.notices.at(-1).message, /replaced .*WATCHDOG\.yml/);

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
await registrations.commands.get("verifier").handler("uninstall --force", { ...ctx, cwd: customRepo });
assert.match(registrations.notices.at(-1).message, /removed .*WATCHDOG\.yml/);
assert.match(registrations.notices.at(-1).message, /kept customized .*config\.yml/);

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

await registrations.commands.get("verifier").handler("install local global", { ...ctx, cwd: globalRepo, agentDir });
assert.match(registrations.notices.at(-1).message, /Usage:/);

console.log("verifier advisor install/uninstall smoke test passed");
