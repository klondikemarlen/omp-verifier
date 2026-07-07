import assert from "node:assert/strict";
import verifierPlugin from "../index.js";

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
assert.deepEqual([...registrations.commands.keys()].sort(), ["verifier-info", "verify-pr"]);
assert.deepEqual([...registrations.tools.keys()].sort(), ["boot_app_plan", "format_pr_comment", "verify_pr_plan"]);
assert.ok(registrations.events.has("session_start"));

await registrations.commands.get("verifier-info").handler("", ctx);
assert.match(registrations.notices.at(-1).message, /verify-pr/);

await registrations.commands.get("verify-pr").handler("~/code/klondikemarlen/example 42", ctx);
assert.match(registrations.messages.at(-1).message, /PR #42/);
assert.deepEqual(registrations.messages.at(-1).options, { deliverAs: "followUp", triggerTurn: true });

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
