import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verifierPlugin from "../omp-plugin/index.js";

const SERIALIZED_WATCHDOG_ROSTER = `instructions: "Everyone: keep advice concrete, evidence-first, and non-repetitive.\\n"
advisors: 
  - name: default
    tools: 
      - read
      - grep
      - glob
    instructions: "@~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md\\n\\nYou are the always-on verifier for this session.\\nReview completed code-change turns as untrusted until evidence proves them.\\nRaise a blocker when work is called done without observed evidence.\\nRaise a concern when checks are too broad, too narrow, or ignore local setup.\\nStay silent when the evidence is sufficient.\\n\\nProject-specific rules can live in downstream WATCHDOG files: setup commands,\\ntest commands, database/service details, browser routes, and \\"done means\\" checks.\\n"
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
const verifier = registrations.commands.get("verifier");
assert.deepEqual(verifier.getArgumentCompletions("").map(item => item.label), ["install", "init-local", "uninstall", "status"]);
assert.deepEqual(verifier.getArgumentCompletions("install ").map(item => item.label), ["replace"]);
assert.deepEqual(verifier.getArgumentCompletions("install r").map(item => item.label), ["replace"]);
assert.equal(verifier.getArgumentCompletions("uninstall "), null);
assert.deepEqual(verifier.getArgumentCompletions("init-local ").map(item => item.label), ["replace"]);
assert.ok(registrations.events.has("session_start"));

const shippedWatchdog = await readFile(new URL("../WATCHDOG.md", import.meta.url), "utf8");
assert.match(shippedWatchdog, /one blank line between adjacent sibling logical blocks/);
assert.match(shippedWatchdog, /cite changed-file line evidence and the local pattern/);

const agentDir = await mkdtemp(join(tmpdir(), "omp-verifier-agent-"));
const repo = await mkdtemp(join(tmpdir(), "omp-verifier-repo-"));
const globalWatchdogPath = join(agentDir, "WATCHDOG.yml");
const globalLocalRulesPath = join(agentDir, "WATCHDOG.local.md");

await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Verifier plugin loaded; created .*WATCHDOG\.yml/);
let globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /# omp-verifier: generated\ninstructions: \|/);
assert.match(globalWatchdog, /reply with "No advice\."/);
assert.match(await readFile(globalLocalRulesPath, "utf8"), /# Local Verifier Rules/);
await assert.rejects(readFile(join(repo, "WATCHDOG.yml"), "utf8"), /ENOENT/);
await assert.rejects(readFile(join(repo, ".omp", "config.yml"), "utf8"), /ENOENT/);

await writeFile(globalWatchdogPath, `${globalWatchdog}\n# stale generated edit\n`);
await verifier.handler("install", { ...ctx, cwd: repo, agentDir });
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.doesNotMatch(globalWatchdog, /stale generated edit/);
assert.match(registrations.notices.at(-1).message, /replaced customized .*WATCHDOG\.yml/);

await writeFile(globalWatchdogPath, "custom global watchdog\n");
await verifier.handler("install global replace", { ...ctx, cwd: repo, agentDir });
assert.match(await readFile(globalWatchdogPath, "utf8"), /# omp-verifier: generated\ninstructions: \|/);
assert.match(registrations.notices.at(-1).message, /replaced customized .*WATCHDOG\.yml/);

await writeFile(globalWatchdogPath, SERIALIZED_WATCHDOG_ROSTER);
await verifier.handler("install global", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /replaced generated .*WATCHDOG\.yml/);

await verifier.handler("status", { ...ctx, cwd: repo, agentDir });
const statusMessage = registrations.notices.at(-1).message;
assert.match(statusMessage, /Verifier status:/);
assert.match(statusMessage, /plugin version: /);
assert.match(statusMessage, /global WATCHDOG\.yml: generated — /);
assert.match(statusMessage, /global WATCHDOG\.local\.md: generated — /);
assert.match(statusMessage, /project WATCHDOG\.yml: absent — /);
assert.match(statusMessage, /project \.omp\/config\.yml: absent — /);
assert.doesNotMatch(statusMessage, /verify-pr|boot_app_plan|format_pr_comment|verifier-bootstrap/);
await verifier.handler("", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Verifier status:/);

const initLocalPath = join(repo, "WATCHDOG.local.md");
await verifier.handler("init-local", { ...ctx, cwd: repo, agentDir });
const generatedLocalRules = await readFile(initLocalPath, "utf8");
assert.match(generatedLocalRules, /## Project setup/);
assert.match(generatedLocalRules, /## Targeted checks/);
assert.match(generatedLocalRules, /## Browser\/UI smoke/);
assert.match(generatedLocalRules, /## High-risk areas/);
assert.match(generatedLocalRules, /## Local PASS \/ FAIL \/ BLOCKED/);
await verifier.handler("init-local", { ...ctx, cwd: repo, agentDir });
assert.equal(await readFile(initLocalPath, "utf8"), generatedLocalRules);
assert.match(registrations.notices.at(-1).message, /kept generated local rules/);
await writeFile(initLocalPath, `${generatedLocalRules}\nTeam smoke: dashboard\n`);
await verifier.handler("init-local", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /kept customized local rules/);
await verifier.handler("init-local replace", { ...ctx, cwd: repo, agentDir });
assert.equal(await readFile(initLocalPath, "utf8"), generatedLocalRules);
assert.match(registrations.notices.at(-1).message, /replaced customized local rules/);

await verifier.handler("install local", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Usage:/);
await verifier.handler("uninstall local", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Usage:/);

await verifier.handler("uninstall", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /removed .*WATCHDOG\.yml/);
assert.match(registrations.notices.at(-1).message, /removed local rules .*WATCHDOG\.local\.md/);
await assert.rejects(readFile(globalWatchdogPath, "utf8"), /ENOENT/);
await assert.rejects(readFile(globalLocalRulesPath, "utf8"), /ENOENT/);

await writeFile(globalWatchdogPath, "custom global watchdog\n");
await writeFile(globalLocalRulesPath, "custom local rules\n");
await verifier.handler("uninstall global", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /kept customized .*WATCHDOG\.yml/);
assert.match(registrations.notices.at(-1).message, /kept customized local rules/);
assert.equal(await readFile(globalWatchdogPath, "utf8"), "custom global watchdog\n");
assert.equal(await readFile(globalLocalRulesPath, "utf8"), "custom local rules\n");

console.log("verifier advisor install/uninstall smoke test passed");
