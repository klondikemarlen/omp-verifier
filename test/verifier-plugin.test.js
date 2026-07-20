import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verifierPlugin, { uninstall as uninstallHook } from "../omp-plugin/index.js";

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
assert.deepEqual(verifier.getArgumentCompletions("").map(item => item.label), ["status", "uninstall"]);
assert.equal(verifier.getArgumentCompletions("uninstall "), null);
assert.ok(registrations.events.has("session_start"));

const shippedWatchdog = await readFile(new URL("../WATCHDOG.md", import.meta.url), "utf8");
assert.match(shippedWatchdog, /distinct verifier advisor/);
assert.match(shippedWatchdog, /`default` advisor owns generic code quality/);
assert.match(shippedWatchdog, /explicit verifier requirement/);
assert.match(shippedWatchdog, /`PASS` — evidence proves the requirement/);
assert.match(shippedWatchdog, /For `FAIL` or `BLOCKED`, cite the requirement/);

const agentDir = await mkdtemp(join(tmpdir(), "omp-verifier-agent-"));
const repo = await mkdtemp(join(tmpdir(), "omp-verifier-repo-"));
const globalWatchdogPath = join(agentDir, "WATCHDOG.yml");
const guidancePath = join(agentDir, "verifier", "WATCHDOG.md");

await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
assert.deepEqual(registrations.notices.at(-1), { message: "Verifier advisor ready.", level: "info" });
let globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /^advisors:\n  - name: default\n\n# omp-verifier: advisor begin\n  - name: verifier/m);
assert.match(globalWatchdog, new RegExp(`@${guidancePath}`));
assert.doesNotMatch(globalWatchdog, /Review completed code-change turns/);
assert.equal(await readFile(guidancePath, "utf8"), shippedWatchdog);
await writeFile(guidancePath, "custom verifier guidance\n");
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
assert.deepEqual(registrations.notices.at(-1), { message: "Verifier advisor ready.", level: "info" });
assert.equal(await readFile(guidancePath, "utf8"), shippedWatchdog);

const learnerAdvisor = `# omp-learner: begin
  - name: learner
    instructions: |
      Preserve durable project knowledge.
# omp-learner: end
`;
await writeFile(globalWatchdogPath, `${globalWatchdog}${learnerAdvisor}`);
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /name: default/);
assert.match(globalWatchdog, /name: verifier/);
assert.match(globalWatchdog, /name: learner/);
assert.match(globalWatchdog, /Preserve durable project knowledge/);

const legacyWatchdog = `# omp-verifier: generated
instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
# omp-verifier: advisor begin
  - name: verifier
    instructions: |
      @~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md
      Review completed code-change turns as untrusted until evidence proves them.
# omp-verifier: advisor end
${learnerAdvisor}`;
await writeFile(globalWatchdogPath, legacyWatchdog);
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /^advisors:\n  - name: default\n\n# omp-verifier: advisor begin\n  - name: verifier/m);
assert.match(globalWatchdog, new RegExp(`@${guidancePath}`));
assert.doesNotMatch(globalWatchdog, /# omp-verifier: generated/);
assert.doesNotMatch(globalWatchdog, /Review completed code-change turns/);
assert.match(globalWatchdog, /name: learner/);

await verifier.handler("status", { ...ctx, cwd: repo, agentDir });
const statusMessage = registrations.notices.at(-1).message;
assert.match(statusMessage, /Verifier status:/);
assert.match(statusMessage, /global roster: default, verifier, learner/);
assert.match(statusMessage, /project roster: absent/);
assert.match(statusMessage, new RegExp(`guidance: installed — ${guidancePath}`));

await verifier.handler("uninstall", { ...ctx, cwd: repo, agentDir });
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /name: default/);
assert.match(globalWatchdog, /name: learner/);
assert.doesNotMatch(globalWatchdog, /name: verifier/);
await assert.rejects(readFile(guidancePath, "utf8"), /ENOENT/);
await uninstallHook({ agentDir });
assert.doesNotMatch(await readFile(globalWatchdogPath, "utf8"), /name: verifier/);

const customAgentDir = await mkdtemp(join(tmpdir(), "omp-verifier-custom-"));
const customWatchdogPath = join(customAgentDir, "WATCHDOG.yml");
const customGuidancePath = join(customAgentDir, "verifier", "WATCHDOG.md");
await writeFile(customWatchdogPath, "instructions: |\n  Keep custom setup.\n\nadvisors:\n  - name: learner\n");
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir: customAgentDir });
const customWatchdog = await readFile(customWatchdogPath, "utf8");
assert.match(customWatchdog, /Keep custom setup/);
assert.match(customWatchdog, /name: default/);
assert.match(customWatchdog, /name: verifier/);
assert.match(customWatchdog, /name: learner/);
await writeFile(customGuidancePath, "custom verifier guidance\n");
await uninstallHook({ agentDir: customAgentDir });
assert.equal(await readFile(customGuidancePath, "utf8"), "custom verifier guidance\n");

console.log("agent-owned verifier guidance lifecycle smoke test passed");
