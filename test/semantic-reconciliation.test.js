import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAutomaticVerificationForPaths } from "#root/omp-plugin/verifications.js";
import { completeSemanticEvaluation, readSemanticEvaluation } from "#root/omp-plugin/semantic-evaluations.js";

const ID = "publisher:scope";
const SOURCE = "export const live = 1;\n";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "verifier-reconcile-"));
  const cwd = join(root, "project");
  const packageDirectory = join(root, "plugins");
  const provider = join(packageDirectory, "publisher");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(provider, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await writeFile(join(cwd, "src/live.js"), "export const live = 0;\n");
  await writeFile(join(cwd, "src/restored.js"), "export const restored = true;\n");
  await writeFile(join(cwd, "src/removed.js"), "export const removed = true;\n");
  await writeFile(join(cwd, "AGENTS.md"), "Live exports equal one. Deleted source may remain deleted.\n");
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "base");
  const baseRef = git("rev-parse", "HEAD");
  await writeFile(join(cwd, "src/live.js"), SOURCE);
  await rm(join(cwd, "src/removed.js"));
  git("add", ".");
  git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "delivery");
  const manifest = { name: "publisher", version: "1.0.0", omp: { extensions: ["./index.js"], verifications: [{
    id: ID, label: "Live Exports", description: "Validate live export values.", mode: "agentic", contract: "./contract.json", pathTriggers: ["src/*.js"],
  }] } };
  await writeFile(join(provider, "package.json"), JSON.stringify(manifest));
  await writeFile(join(provider, "standard.md"), "Live exports equal one. Deleted source may remain deleted.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({ version: 1, standardId: ID, source: "./standard.md", gold: "Live exports equal one.", requiredContext: ["changed-code", "project-guidance"], rubric: [{ id: "value", question: "Do live exports equal one?" }] }));
  const prepare = async (changedPaths = [], options = {}) => (await runAutomaticVerificationForPaths({ cwd, packageDirectory, baseRef, changedPaths, ...options })).find(result => result.id === ID);
  return { root, cwd, provider, manifest, prepare, git };
}

function assessment(requestId) {
  return { requestId, status: "PASS", summary: "The live value equals one.", rationale: "The current source exports one; the other delivery path is an allowed deletion.", citations: [{ path: "src/live.js", line: 1, quote: SOURCE.trim() }] };
}

test("when automatic candidates are obsolete, changed source excludes them but guidance and committed deletions remain", async () => {
  // Arrange
  const f = await fixture();
  try {
    // Act
    const result = await f.prepare(["src/restored.js", "src/temporary.js", "AGENTS.md"]);
    // Assert
    assert.equal(result.status, "PENDING");
    assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/live.js", "src/removed.js"]);
    assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/removed.js").state, "deleted");
    assert.ok(result.reviewRequest.context.projectGuidance.some(record => record.path === "AGENTS.md"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const mutation of ["restored source", "temporary cleanup", "provider update", "inventory change", "changed source", "guidance change"]) {
  test(`when ${mutation} invalidates an automatic request, evaluation returns fresh evidence instead of accepting the old draft`, async () => {
    // Arrange
    const f = await fixture();
    try {
      await writeFile(join(f.cwd, "src/restored.js"), "export const restored = false;\n");
      await writeFile(join(f.cwd, "src/temporary.js"), "export const diagnostic = 1;\n");
      const original = await f.prepare(["src/restored.js", "src/temporary.js"]);
      if (mutation === "restored source") f.git("checkout", "HEAD", "--", "src/restored.js");
      if (mutation === "temporary cleanup") await rm(join(f.cwd, "src/temporary.js"));
      if (mutation === "provider update") await writeFile(join(f.provider, "package.json"), JSON.stringify({ ...f.manifest, version: "2.0.0" }));
      if (mutation === "inventory change") await writeFile(join(f.cwd, "src/diagnostic.js"), "export const extra = 1;\n");
      if (mutation === "changed source") await writeFile(join(f.cwd, "src/live.js"), "export const live = -1;\n");
      if (mutation === "guidance change") await writeFile(join(f.cwd, "AGENTS.md"), "Live exports must now equal two.\n");
      // Act
      const result = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path, assessment: assessment(original.reviewRequest.requestId) });
      // Assert
      assert.equal(result.status, "PENDING");
      assert.notEqual(result.reviewRequest.requestId, original.reviewRequest.requestId);
      assert.equal(result.evaluation.supersededBy, result.reviewRequest.requestId);
      const expected = ["src/live.js", "src/removed.js"];
      if (mutation !== "restored source") expected.push("src/restored.js");
      if (mutation !== "temporary cleanup") expected.push("src/temporary.js");
      assert.deepEqual(result.reviewRequest.scope.changedPaths, expected);
      if (mutation === "provider update") assert.equal(result.reviewRequest.standard.sourceDetails.version, "2.0.0");
      if (mutation === "changed source") assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/live.js").content, "export const live = -1;\n");
      if (mutation === "guidance change") assert.equal(result.reviewRequest.context.projectGuidance.find(record => record.path === "AGENTS.md").content, "Live exports must now equal two.\n");
      if (mutation === "inventory change") assert.ok(result.reviewRequest.context.sourceInventory.files.some(record => record.path === "src/diagnostic.js"));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test("when completed automatic evidence changes, exact recovery cannot reuse its prior PASS", async () => {
  // Arrange
  const f = await fixture();
  try {
    const original = await f.prepare();
    const accepted = await completeSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path, assessment: assessment(original.reviewRequest.requestId) });
    await writeFile(join(f.cwd, "src/live.js"), "export const live = -1;\n");
    // Act
    const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path });
    // Assert
    assert.equal(accepted.status, "PASS");
    assert.equal(accepted.evaluation.requestId, original.reviewRequest.requestId);
    assert.equal(result.status, "PENDING");
    assert.notEqual(result.reviewRequest.requestId, original.reviewRequest.requestId);
    assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/live.js").content, "export const live = -1;\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("when an automatic request is tampered with, reconciliation remains blocked", async () => {
  // Arrange
  const f = await fixture();
  try {
    const original = await f.prepare();
    await writeFile(original.reviewRequest.path, `${await readFile(original.reviewRequest.path, "utf8")}\n`);
    // Act
    const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path });
    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /tampered/);
    assert.equal(result.reviewRequest, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("when the current delivery no longer selects a removed provider, its old result is superseded without approval", async () => {
  // Arrange
  const f = await fixture();
  try {
    const original = await f.prepare();
    await rm(f.provider, { recursive: true });
    // Act
    const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path });
    // Assert
    assert.equal(result.status, "SUPERSEDED");
    assert.equal(result.reviewRequest, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("when a current requirement loses its provider, recovery reports that prerequisite instead of the stale manifest", async () => {
  // Arrange
  const f = await fixture();
  try {
    const original = await f.prepare();
    await writeFile(join(f.cwd, ".omp-verifier.json"), JSON.stringify({ requirements: [{ id: ID, path: "src/*.js" }] }));
    await rm(f.provider, { recursive: true });
    // Act
    const result = await readSemanticEvaluation({ cwd: f.cwd, requestPath: original.reviewRequest.path });
    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, /required|Required/);
    assert.equal(result.reviewRequest, undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("when automatic verification has no delivery base, explicit candidates are not silently dropped", async () => {
  // Arrange
  const f = await fixture();
  try {
    // Act
    const result = await f.prepare(["src/restored.js", "src/temporary.js"], { baseRef: undefined });
    // Assert
    assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/restored.js", "src/temporary.js"]);
    assert.equal(result.reviewRequest.scope.automatic, undefined);
    assert.ok(result.reviewRequest.missingContext.some(reason => reason.includes("src/temporary.js")));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
