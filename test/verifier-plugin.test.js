import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verifierPlugin, { installGlobalVerifier, uninstall as uninstallHook } from "../omp-plugin/index.js";

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
assert.deepEqual(verifier.getArgumentCompletions("").map(item => item.label), ["status", "uninstall"]);
assert.equal(verifier.getArgumentCompletions("uninstall "), null);
assert.ok(registrations.events.has("session_start"));

const shippedWatchdog = await readFile(new URL("../WATCHDOG.md", import.meta.url), "utf8");
assert.match(shippedWatchdog, /Act as an evidence verifier/);
assert.match(shippedWatchdog, /Prefer the evidence already shown/);
assert.match(shippedWatchdog, /Style evidence order/);
assert.match(shippedWatchdog, /changed-file lines/);
assert.match(shippedWatchdog, /direct correctness, security, or data-loss risk/);
assert.match(shippedWatchdog, /concrete failure mode/);
assert.match(shippedWatchdog, /visibly exposes a direct code risk/);
assert.match(shippedWatchdog, /even if no completion claim is made/);
assert.match(shippedWatchdog, /Do not flag a hypothetical or stylistic concern/);
assert.match(shippedWatchdog, /A tool-result summary is not evidence that no direct risk exists/);
assert.match(shippedWatchdog, /eval.*caller-supplied value/);
assert.match(shippedWatchdog, /arbitrary code execution/);
const concepts = await readFile(new URL("../CONCEPTS.md", import.meta.url), "utf8");
assert.match(concepts, /`\/verifier uninstall` for safe cleanup/);
assert.match(concepts, /WATCHDOG\.local\.md/);
assert.doesNotMatch(concepts, /`\/verifier install/);

const agentDir = await mkdtemp(join(tmpdir(), "omp-verifier-agent-"));
const repo = await mkdtemp(join(tmpdir(), "omp-verifier-repo-"));
const globalWatchdogPath = join(agentDir, "WATCHDOG.yml");
const globalLocalRulesPath = join(agentDir, "WATCHDOG.local.md");
const globalConfigPath = join(agentDir, "config.yml");

await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Verifier plugin loaded; created .*WATCHDOG\.yml/);
let globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /# omp-verifier: generated\ninstructions: \|/);
assert.match(globalWatchdog, /reply with "No advice\."/);
assert.match(globalWatchdog, /name: verifier/);
const globalLocalRules = await readFile(globalLocalRulesPath, "utf8");
assert.match(globalLocalRules, /## Human-readable code/);
assert.match(globalLocalRules, /Gold examples/);
assert.match(globalLocalRules, /named intermediate values over nested ternaries/);
assert.match(globalLocalRules, /each semantic decision or transformation in its own statement/);
const previousGeneratedLocalRules = globalLocalRules.replace(/## Human-readable code\n\n(?:.*\n){6}\n/, "");
await writeFile(globalLocalRulesPath, previousGeneratedLocalRules);
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /replaced generated local rules/);
assert.match(await readFile(globalLocalRulesPath, "utf8"), /## Human-readable code/);
const learnerAdvisor = `  # omp-learner: begin
  - name: learner
    instructions: |
      Preserve durable project knowledge.
  # omp-learner: end
`;
const staleWatchdog = globalWatchdog
  .replace("- name: verifier", "- name: default")
  .replace('reply with "No advice."', 'reply with "Stale verifier guidance."');
await writeFile(globalWatchdogPath, `${staleWatchdog}${learnerAdvisor}`);
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /# omp-verifier: advisor begin/);
assert.match(globalWatchdog, /When the evidence is sufficient, do not call the advice tool/);
assert.match(globalWatchdog, /name: learner/);
assert.doesNotMatch(globalWatchdog, /name: default/);
assert.match(globalWatchdog, /Preserve durable project knowledge/);
assert.match(registrations.notices.at(-1).message, /refreshed verifier advisor/);
const defaultAdvisor = `  - name: default
    instructions: |
      Keep the regular advisor behavior.
`;
await writeFile(globalWatchdogPath, `${globalWatchdog}${defaultAdvisor}`);
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /name: verifier/);
assert.match(globalWatchdog, /name: default/);
assert.match(globalWatchdog, /Keep the regular advisor behavior/);

await assert.rejects(readFile(join(repo, "WATCHDOG.yml"), "utf8"), /ENOENT/);
await assert.rejects(readFile(join(repo, ".omp", "config.yml"), "utf8"), /ENOENT/);


await verifier.handler("status", { ...ctx, cwd: repo, agentDir });
const statusMessage = registrations.notices.at(-1).message;
assert.match(statusMessage, /Verifier status:/);
assert.match(statusMessage, /plugin version: /);
assert.match(statusMessage, /global WATCHDOG\.yml: customized — /);
assert.match(statusMessage, /global WATCHDOG\.local\.md: generated — /);
assert.match(statusMessage, /project WATCHDOG\.yml: absent — /);
assert.match(statusMessage, /project \.omp\/config\.yml: absent — /);
assert.doesNotMatch(statusMessage, /verify-pr|boot_app_plan|format_pr_comment|verifier-bootstrap/);
assert.match(statusMessage, /verifier source: global/);
assert.match(statusMessage, /project override: none/);
assert.match(statusMessage, /advisor: global config absent; project config absent/);
assert.match(statusMessage, /rules: customized/);
await writeFile(globalConfigPath, "modelRoles:\n  advisor: gpt-5.6\nadvisor:\n  enabled: true\n");
await verifier.handler("status", { ...ctx, cwd: repo, agentDir });
const configuredStatusMessage = registrations.notices.at(-1).message;
assert.match(configuredStatusMessage, /advisor: global enabled, model configured; project config absent/);
assert.match(configuredStatusMessage, /global config\.yml: exists; advisor enabled; modelRoles\.advisor configured/);
await verifier.handler("", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Verifier status:/);


await verifier.handler("install", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Usage:/);
await verifier.handler("install local", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Usage:/);
await verifier.handler("init-local", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Usage:/);
await verifier.handler("uninstall now", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Usage:/);

await verifier.handler("uninstall", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Safe cleanup complete: removed verifier advisor .*WATCHDOG\.yml; removed local rules .*WATCHDOG\.local\.md\. Next run: omp plugin uninstall omp-verifier/);
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.doesNotMatch(globalWatchdog, /name: verifier/);
assert.match(globalWatchdog, /name: default/);
assert.match(globalWatchdog, /name: learner/);
await assert.rejects(readFile(globalLocalRulesPath, "utf8"), /ENOENT/);

await uninstallHook({ cwd: repo, agentDir });
assert.match(await readFile(globalWatchdogPath, "utf8"), /name: learner/);
await assert.rejects(readFile(globalLocalRulesPath, "utf8"), /ENOENT/);

await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
await uninstallHook({ cwd: repo, agentDir });
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.doesNotMatch(globalWatchdog, /name: verifier/);
assert.match(globalWatchdog, /name: default/);
assert.match(globalWatchdog, /name: learner/);
await assert.rejects(readFile(globalLocalRulesPath, "utf8"), /ENOENT/);


await writeFile(globalWatchdogPath, "custom global watchdog\n");
await writeFile(globalLocalRulesPath, "custom local rules\n");
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
assert.equal(await readFile(globalWatchdogPath, "utf8"), "custom global watchdog\n");
assert.equal(await readFile(globalLocalRulesPath, "utf8"), "custom local rules\n");

await verifier.handler("uninstall", { ...ctx, cwd: repo, agentDir });
assert.match(registrations.notices.at(-1).message, /Safe cleanup complete: kept customized .*WATCHDOG\.yml \(remove verifier block manually\); kept customized local rules .*WATCHDOG\.local\.md\. Next run: omp plugin uninstall omp-verifier/);
assert.equal(await readFile(globalWatchdogPath, "utf8"), "custom global watchdog\n");
assert.equal(await readFile(globalLocalRulesPath, "utf8"), "custom local rules\n");
await uninstallHook({ cwd: repo, agentDir });
assert.equal(await readFile(globalWatchdogPath, "utf8"), "custom global watchdog\n");
assert.equal(await readFile(globalLocalRulesPath, "utf8"), "custom local rules\n");
const explicitReplacement = await installGlobalVerifier({ agentDir }, { replace: true });
assert.match(explicitReplacement[0], /replaced customized .*WATCHDOG\.yml/);
globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /name: verifier/);
assert.doesNotMatch(globalWatchdog, /custom global watchdog/);

console.log("verifier advisor status/lifecycle smoke test passed");
