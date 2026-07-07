import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
assert.deepEqual([...registrations.commands.keys()].sort(), ["verifier-bootstrap", "verifier-info"]);
assert.ok(registrations.events.has("session_start"));

await registrations.commands.get("verifier-info").handler("", ctx);
assert.match(registrations.notices.at(-1).message, /verifier-bootstrap/);
assert.doesNotMatch(registrations.notices.at(-1).message, /verify-pr|verify_pr_plan|boot_app_plan|format_pr_comment/);

const tempRepo = await mkdtemp(join(tmpdir(), "omp-verifier-"));
await registrations.commands.get("verifier-bootstrap").handler("", { ...ctx, cwd: tempRepo });
const configPath = join(tempRepo, ".omp", "config.yml");
const watchdogPath = join(tempRepo, "WATCHDOG.yml");
assert.match(await readFile(configPath, "utf8"), /advisor:\n  enabled: true/);
assert.match(await readFile(watchdogPath, "utf8"), /@~\/.omp\/plugins\/node_modules\/omp-verifier\/WATCHDOG\.md/);
assert.match(registrations.notices.at(-1).message, /created/);

await writeFile(configPath, "custom: true\n");
await registrations.commands.get("verifier-bootstrap").handler("--force", { ...ctx, cwd: tempRepo });
assert.equal(await readFile(configPath, "utf8"), "custom: true\n");
assert.match(await readFile(watchdogPath, "utf8"), /always-on verifier/);
assert.match(registrations.notices.at(-1).message, /kept existing .*config\.yml.*merge advisor keys manually/);
assert.match(registrations.notices.at(-1).message, /replaced .*WATCHDOG\.yml/);

console.log("verifier advisor bootstrap smoke test passed");
