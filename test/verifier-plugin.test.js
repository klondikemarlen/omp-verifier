import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verifierPlugin from "../omp-plugin/index.js";

function zChain() {
  return {
    describe() { return this; },
    int() { return this; },
    positive() { return this; },
    optional() { return this; },
    default() { return this; },
  };
}

const registrations = { commands: new Map(), tools: new Map(), events: new Map(), messages: [], notices: [] };
const pi = {
  zod: {
    z: {
      object: (shape) => ({ shape }),
      string: zChain,
      number: zChain,
      array: zChain,
      enum: (values) => ({ values }),
    },
  },
  setLabel(label) { registrations.label = label; },
  on(event, handler) { registrations.events.set(event, handler); },
  registerCommand(name, command) { registrations.commands.set(name, command); },
  registerTool(tool) { registrations.tools.set(tool.name, tool); },
  async sendMessage(message, options) { registrations.messages.push({ message, options }); },
};
const ctx = { ui: { notify(message, level) { registrations.notices.push({ message, level }); } } };

verifierPlugin(pi);

assert.equal(registrations.label, "Verifier");
assert.deepEqual([...registrations.commands.keys()].sort(), ["verifier-bootstrap", "verifier-info", "verify-pr"]);
assert.deepEqual([...registrations.tools.keys()].sort(), ["boot_app_plan", "format_pr_comment", "verify_pr_plan"]);
assert.ok(registrations.events.has("session_start"));

await registrations.commands.get("verifier-info").handler("", ctx);
assert.match(registrations.notices.at(-1).message, /verify-pr/);
assert.match(registrations.notices.at(-1).message, /verifier-bootstrap/);
assert.match(registrations.notices.at(-1).message, /project-verifier/);
assert.doesNotMatch(registrations.notices.at(-1).message, /wrap-verifier/);

await registrations.commands.get("verify-pr").handler("~/code/klondikemarlen/example 42", ctx);
assert.match(registrations.messages.at(-1).message, /PR #42/);
assert.match(registrations.messages.at(-1).message, /project-verifier/);
assert.match(registrations.messages.at(-1).message, /local project conventions/);
assert.deepEqual(registrations.messages.at(-1).options, { deliverAs: "followUp", triggerTurn: true });

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

const verifyPlan = await registrations.tools.get("verify_pr_plan").execute("1", { repo: "/repo", pr: 42 });
assert.match(verifyPlan.content[0].text, /Gold outcome/);
assert.match(verifyPlan.content[0].text, /pr-42/);

const bootPlan = await registrations.tools.get("boot_app_plan").execute("2", { repo: "/repo", pr: 42, basePort: 3000 });
assert.equal(bootPlan.details.port, 3042);

const comment = await registrations.tools.get("format_pr_comment").execute("3", {
  verdict: "PASS",
  evidence: ["npm run check passed"],
  risks: [],
});
assert.match(comment.content[0].text, /Verifier verdict: PASS/);
assert.match(comment.content[0].text, /npm run check passed/);

console.log("verifier plugin registration and command/tool smoke test passed");
