import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { captureSemanticContext, semanticContextMissing, validateSemanticCitations } from "#root/omp-plugin/semantic-context.js";

const sourceRecovery = { chunkBytes: 16_000, maxSourceBytes: 256_000, modelContext: "unavailable" };
const hash = content => createHash("sha256").update(content).digest("hex");

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "semantic-source-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "recovery@example.test");
  git("config", "user.name", "Recovery Test");
  git("add", ".");
  git("commit", "-qm", "initial source");
  const capture = (changedPaths, options = {}) => captureSemanticContext({ repositoryRoot: root, changedPaths, sourceRecovery, ...options });
  return { root, git, capture };
}

function sizedLines(bytes, count) {
  const bodyBytes = bytes - count + 1;
  const width = Math.floor(bodyBytes / (count - 1));
  const remainder = bodyBytes % (count - 1);
  return Array.from({ length: count - 1 }, (_, index) => "x".repeat(width + (index < remainder ? 1 : 0))).join("\n") + "\n";
}

test("when automatic capture receives a 34208-byte 144-line guide, every line including final empty is recovered", async t => {
  // Arrange
  const content = sizedLines(34_208, 144);
  const { capture } = await fixture(t, { "AGENTS.md": content });

  // Act
  const captured = await capture(["AGENTS.md"]);

  // Assert
  assert.equal(Buffer.byteLength(content), 34_208);
  assert.equal(content.split("\n").length, 144);
  const records = captured.context.changedCode.filter(record => record.path === "AGENTS.md" && typeof record.content === "string");
  assert.ok(records.length > 1);
  assert.equal(records.map(record => record.content).join("\n"), content);
  assert.ok(records.every(record => Buffer.byteLength(record.content) <= sourceRecovery.chunkBytes));
  assert.ok(records.every(record => record.state === "present" && record.sha256 === hash(content)));
  assert.deepEqual(captured.context.changedCodeCoverage, [{ path: "AGENTS.md", lineCount: 144, coveredRanges: [[1, 144]], omittedRanges: [], complete: true }]);
  assert.deepEqual(captured.context.missingChangedPaths, []);
  assert.equal(records.at(-1).content.split("\n").at(-1), "");
  assert.deepEqual(semanticContextMissing(["changed-code", "project-guidance"], captured), []);
  assert.deepEqual(captured.context.sourceRecovery, sourceRecovery);
  assert.ok(captured.context.evidenceBudget.records.filter(record => record.path === "AGENTS.md").length > 1);
});

test("when a nested directory is deleted in Git, historical source and deleted citations remain authenticated", async t => {
  // Arrange
  const content = sizedLines(17_198, 90);
  const { root, git, capture } = await fixture(t, { "nested/removed/helper.js": content });
  await rm(join(root, "nested"), { recursive: true });
  git("add", "-A");
  git("commit", "-qm", "delete nested source");
  // Act
  const { context } = await capture(["nested/removed/helper.js"]);
  // Assert
  const records = context.changedCode.filter(record => record.path === "nested/removed/helper.js" && typeof record.content === "string");
  assert.ok(records.length > 1);
  assert.equal(records.map(record => record.content).join("\n"), content);
  assert.ok(records.every(record => Buffer.byteLength(record.content) <= sourceRecovery.chunkBytes));
  assert.ok(records.every(record => record.state === "deleted" && record.sha256 === hash(content)));
  assert.deepEqual(context.changedCodeCoverage, [{ path: "nested/removed/helper.js", lineCount: 90, coveredRanges: [[1, 90]], omittedRanges: [], complete: true }]);
  assert.deepEqual(context.missingChangedPaths, []);
  assert.ok(records.every(record => record.previousSha256 === hash(content) && /^[a-f0-9]+\^:nested\/removed\/helper\.js$/.test(record.reference)));
  assert.ok(context.siblingInventory.every(record => record.complete));
  const line = records[1].startLine;
  assert.deepEqual(validateSemanticCitations([{ path: "nested/removed/helper.js", line, quote: content.split("\n")[line - 1] }], context), [{ path: "nested/removed/helper.js", line, quote: content.split("\n")[line - 1], state: "deleted" }]);
  await assert.rejects(readFile(join(root, "nested/removed/helper.js")), { code: "ENOENT" });
});

test("when source contains multibyte characters, chunks preserve characters, line numbers, hashes, and citations", async t => {
  // Arrange
  const content = Array.from({ length: 120 }, (_, index) => `${index}: ${"é界🙂".repeat(30)}`).join("\n") + "\n";
  const { capture } = await fixture(t, { "helper.js": content });
  // Act
  const { context } = await capture(["helper.js"]);
  // Assert
  const records = context.changedCode.filter(record => record.path === "helper.js" && typeof record.content === "string");
  assert.ok(records.length > 1);
  assert.equal(records.map(record => record.content).join("\n"), content);
  assert.ok(records.every(record => Buffer.byteLength(record.content) <= sourceRecovery.chunkBytes));
  assert.ok(records.every(record => record.state === "present" && record.sha256 === hash(content)));
  assert.deepEqual(context.changedCodeCoverage, [{ path: "helper.js", lineCount: 121, coveredRanges: [[1, 121]], omittedRanges: [], complete: true }]);
  assert.deepEqual(context.missingChangedPaths, []);
  for (const record of records) {
    const line = record.startLine ?? 1;
    const quote = record.content.split("\n")[0];
    assert.deepEqual(validateSemanticCitations([{ path: "helper.js", line, quote }], context), [{ path: "helper.js", line, quote }]);
    assert.equal(record.content.includes("�"), false);
  }
});

test("when required guidance and optional callers are oversized, only required guidance is automatically recovered", async t => {
  // Arrange
  const guide = sizedLines(34_208, 144);
  const caller = `// helper\n${sizedLines(20_000, 100)}`;
  const { capture } = await fixture(t, { "src/helper.js": "export const helper = 1;\n", "AGENTS.md": guide, "src/caller.js": caller });
  // Act
  const captured = await capture(["src/helper.js"]);
  // Assert
  const records = captured.context.projectGuidance;
  assert.equal(records.map(record => record.content).join("\n"), guide);
  assert.ok(records.every(record => Buffer.byteLength(record.content) <= 16_000));
  assert.deepEqual(captured.context.missingGuidancePaths, []);
  assert.ok(captured.context.evidenceBudget.rejections.some(record => record.path === "src/caller.js"));
});

test("when absent source has no authenticated history, capture diagnoses the prerequisite without restoring source", async t => {
  // Arrange
  const { root, capture } = await fixture(t, { "present.js": "export {};\n" });
  // Act
  const captured = await capture(["never-tracked.js"]);
  // Assert
  assert.deepEqual(captured.context.missingChangedPaths, ["never-tracked.js"]);
  assert.match(captured.context.changedCode[0].reason, /no prior source/);
  assert.ok(semanticContextMissing(["changed-code"], captured).length);
  await assert.rejects(readFile(join(root, "never-tracked.js")), { code: "ENOENT" });
});

for (const [name, content, diagnostic] of [
  ["single-line", "x".repeat(16_001), /line 1 exceeds the 16000-byte.*chunk limit/],
  ["whole-source", sizedLines(256_001, 1000), /256000-byte.*whole-source limit/],
]) {
  test(`when ${name} recovery exceeds its limit, source stays unavailable with an exact diagnostic`, async t => {
    // Arrange
    const { capture } = await fixture(t, { "helper.js": content });
    // Act
    const captured = await capture(["helper.js"]);
    // Assert
    assert.deepEqual(captured.context.missingChangedPaths, ["helper.js"]);
    assert.match(captured.context.changedCode.find(record => record.state === "unavailable").reason, diagnostic);
    assert.equal(captured.context.changedCode.filter(record => typeof record.content === "string").length, 0);
  });
}

test("when required chunks exhaust aggregate capacity, capture preserves the existing byte ceiling", async t => {
  // Arrange
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`source-${index}.js`, sizedLines(240_000, 1000)]));
  const { capture } = await fixture(t, files);
  // Act
  const captured = await capture(Object.keys(files));
  // Assert
  assert.equal(captured.context.evidenceBudget.maxBytes, 1_024_000);
  assert.ok(captured.context.evidenceBudget.usedBytes <= 1_024_000);
  assert.ok(captured.context.missingChangedPaths.length);
  assert.ok(captured.context.evidenceBudget.rejections.some(record => /1024000-byte evidence limit/.test(record.reason)));
  assert.ok(semanticContextMissing(["changed-code"], captured).some(message => /capacity/.test(message)));
});

test("when required scope contains 257 files, capture preserves the existing distinct-file ceiling", async t => {
  // Arrange
  const files = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`source-${index}.js`, "export {};\n"]));
  const { capture } = await fixture(t, files);
  // Act
  const captured = await capture(Object.keys(files));
  // Assert
  assert.equal(captured.context.evidenceBudget.usedFiles, 256);
  assert.equal(captured.context.evidenceBudget.maxFiles, 256);
  assert.ok(captured.context.evidenceBudget.rejections.some(record => /256-file/.test(record.reason)));
  assert.ok(semanticContextMissing(["changed-code"], captured).some(message => /cardinality/.test(message)));
});

test("when manual selectors or explicit limits are supplied, capture preserves their existing semantics", async t => {
  // Arrange
  const content = sizedLines(34_208, 144);
  const { capture } = await fixture(t, { "helper.js": content });

  // Act
  const partial = await capture(["helper.js"], { contextPaths: ["helper.js#L1-L20"] });
  const manual = await capture(["helper.js"], { sourceRecovery: undefined });
  const enlargedManual = await capture(["helper.js"], { sourceRecovery: undefined, maxSourceBytes: 40_000 });

  // Assert
  assert.deepEqual(partial.context.missingChangedPaths, ["helper.js"]);
  assert.equal(partial.context.changedCodeCoverage[0].complete, false);
  assert.deepEqual(partial.context.changedCodeCoverage[0].coveredRanges, [[1, 20]]);
  assert.deepEqual(manual.context.missingChangedPaths, ["helper.js"]);
  assert.equal(manual.context.sourceRecovery, undefined);
  assert.deepEqual(enlargedManual.context.missingChangedPaths, []);
  assert.equal(enlargedManual.context.changedCode.length, 1);
});

test("when recovered source or policy changes, fresh context fingerprints change without unrelated churn", async t => {
  // Arrange
  const content = sizedLines(34_208, 144);
  const { root, capture } = await fixture(t, { "helper.js": content });

  // Act
  const initial = await capture(["helper.js"]);
  const repeated = await capture(["helper.js"]);
  await writeFile(join(root, "helper.js"), content.replace(/x(?=\n$)/, "y"));
  const changed = await capture(["helper.js"]);
  const policyChanged = await capture(["helper.js"], { sourceRecovery: { ...sourceRecovery, chunkBytes: 8_000 } });

  // Assert
  assert.equal(repeated.fingerprint, initial.fingerprint);
  assert.notEqual(changed.fingerprint, initial.fingerprint);
  assert.notEqual(policyChanged.fingerprint, changed.fingerprint);
});

test("when deleted source is cached, only complete authenticated cached chunks establish its previous content", async t => {
  // Arrange
  const content = sizedLines(34_208, 144);
  const { root, capture } = await fixture(t, { "present.js": "export {};\n" });
  await writeFile(join(root, "untracked.js"), content);
  const complete = await capture(["untracked.js"]);
  const partial = await capture(["untracked.js"], { contextPaths: ["untracked.js#L1-L20"] });
  await rm(join(root, "untracked.js"));

  // Act
  const cached = await capture(["untracked.js"], { previousContext: complete.context });
  const incomplete = await capture(["untracked.js"], { previousContext: partial.context });

  // Assert
  const records = cached.context.changedCode.filter(record => record.path === "untracked.js" && typeof record.content === "string");
  assert.ok(records.length > 1);
  assert.equal(records.map(record => record.content).join("\n"), content);
  assert.ok(records.every(record => Buffer.byteLength(record.content) <= sourceRecovery.chunkBytes));
  assert.ok(records.every(record => record.state === "deleted" && record.sha256 === hash(content)));
  assert.deepEqual(cached.context.changedCodeCoverage, [{ path: "untracked.js", lineCount: 144, coveredRanges: [[1, 144]], omittedRanges: [], complete: true }]);
  assert.deepEqual(cached.context.missingChangedPaths, []);
  assert.deepEqual(incomplete.context.missingChangedPaths, ["untracked.js"]);
  assert.match(incomplete.context.changedCode[0].reason, /no prior source/);
});

for (const recovery of [
  { ...sourceRecovery, chunkBytes: 16_001 },
  { ...sourceRecovery, chunkBytes: 0 },
  { ...sourceRecovery, maxSourceBytes: 256_001 },
  { ...sourceRecovery, maxSourceBytes: 1.5 },
]) {
  test(`when recovery bounds are invalid (${JSON.stringify(recovery)}), capture rejects them`, async t => {
    // Arrange
    const { capture } = await fixture(t, { "helper.js": "export {};\n" });

    // Act
    const captured = capture(["helper.js"], { sourceRecovery: recovery });

    // Assert
    await assert.rejects(captured, /positive safe integer/);
  });
}
