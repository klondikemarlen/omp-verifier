import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import verifierPlugin, { uninstall as uninstallHook } from "../omp-plugin/index.js";
import { discoverVerificationChecks, runAutomaticVerification, runVerificationChecks } from "../omp-plugin/verifications.js";

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
assert.deepEqual(verifier.getArgumentCompletions("").map(item => item.label), ["status", "checks", "verify", "uninstall"]);
assert.equal(verifier.getArgumentCompletions("verify "), null);
assert.ok(registrations.events.has("session_start"));
assert.ok(registrations.events.has("agent_end"));

const shippedWatchdog = await readFile(new URL("../WATCHDOG.md", import.meta.url), "utf8");
assert.match(shippedWatchdog, /distinct verifier advisor/);
assert.match(shippedWatchdog, /`default` advisor owns generic code quality/);
assert.match(shippedWatchdog, /explicit verifier requirement/);
assert.match(shippedWatchdog, /`PASS` — evidence proves the requirement/);
assert.match(shippedWatchdog, /For `FAIL` or `BLOCKED`, cite the requirement/);

const verificationCwd = await mkdtemp(join(tmpdir(), "omp-verifier-check-cwd-"));
const verificationPackageDirectory = await mkdtemp(join(tmpdir(), "omp-verifier-packages-"));
async function writeVerificationPackage(name, verifications, files = {}) {
  const packagePath = join(verificationPackageDirectory, name);
  await mkdir(packagePath, { recursive: true });
  await writeFile(
    join(packagePath, "package.json"),
    JSON.stringify({ name, omp: { extensions: ["./index.js"], verifications } }),
  );
  for (const [file, content] of Object.entries(files)) await writeFile(join(packagePath, file), content);
}

const jsonResult = result => `process.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`;
await writeVerificationPackage(
  "publisher-pass",
  [{
    id: "publisher-pass:check",
    label: "Pass check",
    description: "A passing check",
    entry: "./pass.mjs",
    pathTriggers: ["tests/**"],
  }],
  { "pass.mjs": jsonResult({ status: "PASS", summary: "The check passed", evidence: "fixture passed" }) },
);
await writeVerificationPackage(
  "publisher-unrelated",
  [{
    id: "publisher-unrelated:check",
    label: "Unrelated check",
    description: "A check for source files only",
    entry: "./unrelated.mjs",
    pathTriggers: ["src/**"],
  }],
  { "unrelated.mjs": jsonResult({ status: "PASS", summary: "The unrelated check passed" }) },
);
const piOnlyPackagePath = join(verificationPackageDirectory, "publisher-pi-only");
await mkdir(piOnlyPackagePath, { recursive: true });
await writeFile(
  join(piOnlyPackagePath, "package.json"),
  JSON.stringify({
    name: "publisher-pi-only",
    pi: { extensions: ["./index.js"] },
    omp: {
      verifications: [{
        id: "publisher-pi-only:check",
        label: "Pi-only check",
        description: "A pi-only plugin check",
        entry: "./pi-only.mjs",
      }],
    },
  }),
);
await writeFile(join(piOnlyPackagePath, "pi-only.mjs"), jsonResult({ status: "PASS", summary: "The pi-only check passed" }));
await writeVerificationPackage(
  "publisher-fail",
  [{ id: "publisher-fail:check", label: "Fail check", description: "A failing check", entry: "./fail.mjs" }],
  { "fail.mjs": jsonResult({ status: "FAIL", summary: "The check failed", evidence: "fixture failed", nextCheck: "inspect fixture" }) },
);
await writeVerificationPackage(
  "publisher-duplicate-one",
  [{ id: "publisher-duplicate:check", label: "Duplicate one", description: "Duplicate check", entry: "./one.mjs" }],
  { "one.mjs": jsonResult({ status: "PASS", summary: "should not run" }) },
);
await writeVerificationPackage(
  "publisher-duplicate-two",
  [{ id: "publisher-duplicate:check", label: "Duplicate two", description: "Duplicate check", entry: "./two.mjs" }],
  { "two.mjs": jsonResult({ status: "PASS", summary: "should not run" }) },
);
await writeVerificationPackage(
  "publisher-duplicate-three",
  [{ id: "publisher-duplicate:check", label: "Duplicate three", description: "Duplicate check", entry: "./three.mjs" }],
  { "three.mjs": jsonResult({ status: "PASS", summary: "should not run" }) },
);
await writeVerificationPackage(
  "publisher-invalid",
  [{ id: "publisher-invalid:check", label: "Invalid check", description: "Invalid output", entry: "./invalid.mjs" }],
  { "invalid.mjs": 'process.stdout.write("not json");\n' },
);
await writeVerificationPackage(
  "publisher-timeout",
  [{ id: "publisher-timeout:check", label: "Timeout check", description: "Timed out check", entry: "./timeout.mjs", timeoutMs: 10 }],
  { "timeout.mjs": 'setTimeout(() => process.stdout.write("{}"), 1000);\n' },
);
await writeVerificationPackage(
  "publisher-traversal",
  [{ id: "publisher-traversal:check", label: "Traversal check", description: "Unsafe entry", entry: "./../escape.mjs" }],
);
await writeVerificationPackage(
  "publisher-missing-entry",
  [{ id: "publisher-missing-entry:check", label: "Missing entry", description: "Missing entry", entry: "./missing.mjs" }],
);
await writeVerificationPackage(
  "publisher-nonzero",
  [{ id: "publisher-nonzero:check", label: "Non-zero check", description: "Non-zero result", entry: "./nonzero.mjs" }],
  { "nonzero.mjs": "process.exitCode = 2;\n" },
);
const malformedPackagePath = join(verificationPackageDirectory, "publisher-malformed");
await mkdir(malformedPackagePath, { recursive: true });
await writeFile(
  join(malformedPackagePath, "package.json"),
  JSON.stringify({ name: "publisher-malformed", omp: { extensions: ["./index.js"], verifications: "not-an-array" } }),
);
const symlinkPackagePath = join(verificationPackageDirectory, "publisher-symlink");
const outsideCheckPath = join(verificationCwd, "outside-check.mjs");
await mkdir(symlinkPackagePath, { recursive: true });
await writeFile(join(symlinkPackagePath, "package.json"), JSON.stringify({
  name: "publisher-symlink",
  omp: {
    extensions: ["./index.js"],
    verifications: [{
      id: "publisher-symlink:check",
      label: "Symlink check",
      description: "Unsafe symlink entry",
      entry: "./link.mjs",
    }],
  },
}));
await writeFile(outsideCheckPath, jsonResult({ status: "PASS", summary: "should not run" }));
await symlink(outsideCheckPath, join(symlinkPackagePath, "link.mjs"));

const discovered = await discoverVerificationChecks({ packageDirectory: verificationPackageDirectory });
assert.deepEqual(
  discovered.checks.map(check => check.id).sort(),
  [
    "publisher-fail:check",
    "publisher-invalid:check",
    "publisher-missing-entry:check",
    "publisher-nonzero:check",
    "publisher-pass:check",
    "publisher-pi-only:check",
    "publisher-timeout:check",
    "publisher-unrelated:check",
  ],
);
assert.equal(discovered.blockedResults.filter(result => result.id === "publisher-duplicate:check").length, 3);
assert.equal(discovered.blockedResults.find(result => result.id === "publisher-traversal:check").status, "BLOCKED");
assert.equal(discovered.blockedResults.find(result => result.id === "manifest:publisher-malformed").status, "BLOCKED");
assert.equal(discovered.blockedResults.find(result => result.id === "publisher-symlink:check").status, "BLOCKED");

const verificationResults = await runVerificationChecks(discovered.checks, verificationCwd, ["publisher-pass:check", "publisher-pass:check", "publisher-missing:check"]);
assert.deepEqual(verificationResults.map(result => result.id), ["publisher-missing:check", "publisher-pass:check"]);
assert.equal(verificationResults.find(result => result.id === "publisher-pass:check").status, "PASS");

const automaticResults = await runAutomaticVerification({
  cwd: verificationCwd,
  repositoryRoot: verificationCwd,
  changedPaths: ["tests/active/example.test.js"],
  packageDirectory: verificationPackageDirectory,
});
const automaticPass = automaticResults.find(result => result.id === "publisher-pass:check" && result.status === "PASS");
assert.deepEqual(automaticPass.matches, [{ path: "tests/active/example.test.js", trigger: "tests/**" }]);
assert.equal(automaticResults.some(result => result.id === "publisher-unrelated:check"), false);

await writeFile(
  join(verificationCwd, ".omp-verifier.json"),
  JSON.stringify({
    suppressions: [{
      id: "publisher-pass:check",
      path: "tests/suppressed/**",
      reason: "Legacy fixture is intentionally exempt.",
    }],
  }),
);
const suppressedResults = await runAutomaticVerification({
  cwd: verificationCwd,
  repositoryRoot: verificationCwd,
  changedPaths: ["tests/suppressed/example.test.js"],
  packageDirectory: verificationPackageDirectory,
});
assert.equal(suppressedResults.find(result => result.id === "publisher-pass:check").status, "SUPPRESSED");
assert.match(suppressedResults.find(result => result.id === "publisher-pass:check").evidence, /Legacy fixture is intentionally exempt/);

await writeFile(join(verificationCwd, ".omp-verifier.json"), "{\"suppressions\": \"invalid\"}");
const invalidSuppressionResults = await runAutomaticVerification({
  cwd: verificationCwd,
  repositoryRoot: verificationCwd,
  changedPaths: ["tests/active/example.test.js"],
  packageDirectory: verificationPackageDirectory,
});
assert.equal(invalidSuppressionResults.find(result => result.id === "suppression:.omp-verifier.json").status, "BLOCKED");

await registrations.events.get("agent_end")({}, { ...ctx, cwd: verificationCwd, verificationPackageDirectory });
assert.match(registrations.notices.at(-1).message, /BLOCKED verifier:auto-selection/);

await verifier.handler("checks", { ...ctx, cwd: verificationCwd, verificationPackageDirectory });
const checksMessage = registrations.notices.at(-1).message;
assert.match(checksMessage, /Verifier checks:/);
assert.match(checksMessage, /discovered: 8/);
assert.match(checksMessage, /publisher-pass:check — Pass check/);
assert.match(checksMessage, /BLOCKED publisher-duplicate:check/);

await verifier.handler("verify", { ...ctx, cwd: verificationCwd, verificationPackageDirectory });
const verificationMessage = registrations.notices.at(-1).message;
assert.match(verificationMessage, /PASS publisher-pass:check/);
assert.match(verificationMessage, /PASS publisher-pi-only:check/);
assert.match(verificationMessage, /FAIL publisher-fail:check/);
assert.match(verificationMessage, /BLOCKED publisher-missing-entry:check/);
assert.match(verificationMessage, /BLOCKED publisher-nonzero:check/);
assert.match(verificationMessage, /BLOCKED publisher-invalid:check/);
assert.match(verificationMessage, /BLOCKED publisher-symlink:check/);
assert.match(verificationMessage, /BLOCKED publisher-timeout:check/);
assert.match(verificationMessage, /BLOCKED publisher-duplicate:check/);

const emptyVerificationPackageDirectory = await mkdtemp(join(tmpdir(), "omp-verifier-empty-packages-"));
await verifier.handler("checks", { ...ctx, cwd: verificationCwd, verificationPackageDirectory: emptyVerificationPackageDirectory });
assert.match(registrations.notices.at(-1).message, /none installed/);
await verifier.handler("verify", { ...ctx, cwd: verificationCwd, verificationPackageDirectory: emptyVerificationPackageDirectory });
assert.match(registrations.notices.at(-1).message, /BLOCKED verifier — No verification checks are installed/);

registrations.notices.length = 0;
const agentDir = await mkdtemp(join(tmpdir(), "omp-verifier-agent-"));
const repo = await mkdtemp(join(tmpdir(), "omp-verifier-repo-"));
const globalWatchdogPath = join(agentDir, "WATCHDOG.yml");
const guidancePath = join(agentDir, "verifier", "WATCHDOG.md");

await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
assert.equal(registrations.notices.length, 0);
let globalWatchdog = await readFile(globalWatchdogPath, "utf8");
assert.match(globalWatchdog, /^advisors:\n  - name: default\n\n# omp-verifier: advisor begin\n  - name: verifier/m);
assert.match(globalWatchdog, new RegExp(`@${guidancePath}`));
assert.doesNotMatch(globalWatchdog, /Review completed code-change turns/);
assert.equal(await readFile(guidancePath, "utf8"), shippedWatchdog);
await writeFile(guidancePath, "custom verifier guidance\n");
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir });
assert.equal(registrations.notices.length, 0);
assert.equal(await readFile(guidancePath, "utf8"), shippedWatchdog);
const blockedAgentDir = join(agentDir, "blocked");
await writeFile(blockedAgentDir, "not a directory\n");
await registrations.events.get("session_start")({}, { ...ctx, cwd: repo, agentDir: blockedAgentDir });
assert.equal(registrations.notices.length, 1);
assert.equal(registrations.notices.at(-1).level, "warning");
assert.match(registrations.notices.at(-1).message, /^Verifier advisor setup failed:/);

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
await Promise.all([
  rm(verificationPackageDirectory, { recursive: true, force: true }),
  rm(emptyVerificationPackageDirectory, { recursive: true, force: true }),
  rm(verificationCwd, { recursive: true, force: true }),
  rm(agentDir, { recursive: true, force: true }),
  rm(repo, { recursive: true, force: true }),
  rm(customAgentDir, { recursive: true, force: true }),
]);

console.log("agent-owned verifier guidance lifecycle smoke test passed");
