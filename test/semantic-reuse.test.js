import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
} from "#root/omp-plugin/semantic-evaluations.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import { captureDeliveryScope } from "#root/omp-plugin/delivery-scope.js";

const CHECK_ID = "publisher:reuse";
const SOURCE = "export const helper = 1;\n";
const CALLER = "export const runtime = 'helper';\n";
const EXTERNAL_URL = "https://raw.githubusercontent.com/example/contracts/0123456789abcdef0123456789abcdef01234567/contract.md";
const RECOVERY = { chunkBytes: 16_000, maxSourceBytes: 256_000, modelContext: "unavailable" };

async function fixture(t, { source = SOURCE } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "plugins", "publisher");
  await mkdir(packagePath, { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/helper.js"), source);
  await writeFile(join(root, "src/caller.js"), CALLER);
  await writeFile(join(root, "AGENTS.md"), "Respect module ownership.\n");
  await writeFile(join(packagePath, "standard.md"), "Changed modules own their behavior.\n");
  await writeFile(join(packagePath, "contract.json"), JSON.stringify({
    version: 1, standardId: CHECK_ID, source: "./standard.md", gold: "Own meaningful behavior.",
    requiredContext: ["changed-code"], rubric: [{ id: "ownership", question: "Does the module own its behavior?" }],
  }));
  await writeFile(join(packagePath, "package.json"), JSON.stringify({
    name: "publisher", version: "1.0.0",
    omp: { extensions: ["./index.js"], verifications: [{
      id: CHECK_ID, label: "Ownership", description: "Assess ownership.", mode: "agentic", contract: "./contract.json",
      pathTriggers: ["src/*.js"],
    }] },
  }));
  const { checks } = await discoverVerificationChecks({ packageDirectory: join(root, "plugins") });
  return { root, packagePath, options: { cwd: root, check: checks.find(check => check.id === CHECK_ID), changedPaths: ["src/helper.js"] } };
}

function assessment(prepared, status = "PASS", citations = [{ path: "src/helper.js", line: 1, quote: SOURCE.trim() }]) {
  return {
    requestId: prepared.reviewRequest.requestId, status,
    summary: `${status}: ownership reviewed`, rationale: "Observed the selected module under the supplied standard.",
    nextCheck: "Retain the owning boundary.", citations,
  };
}

async function complete(options, prepared, status = "PASS", citations) {
  return completeSemanticEvaluation({
    cwd: options.cwd, requestPath: prepared.reviewRequest.path, assessment: assessment(prepared, status, citations),
  });
}

function stateFile(requestPath) {
  const key = createHash("sha256").update(CHECK_ID).digest("hex");
  return join(dirname(dirname(requestPath)), "states", `${key}.json`);
}

for (const status of ["PASS", "FAIL", "BLOCKED"]) {
  test(`when unchanged ${status} proof is explicitly reusable, preparation retains the exact accepted result`, async t => {
    // Arrange
    const { options } = await fixture(t);
    const prepared = await prepareSemanticEvaluation(options);
    const accepted = await complete(options, prepared, status);
    const requestBefore = await readFile(prepared.reviewRequest.path, "utf8");
    const stateBefore = await readFile(stateFile(prepared.reviewRequest.path), "utf8");

    // Act
    const reused = await prepareSemanticEvaluation({ ...options, reuseExisting: true });

    // Assert
    assert.equal(accepted.status, status);
    assert.deepEqual(reused, accepted);
    assert.equal(reused.evaluation.requestId, prepared.reviewRequest.requestId);
    assert.equal(await readFile(prepared.reviewRequest.path, "utf8"), requestBefore);
    assert.equal(await readFile(stateFile(prepared.reviewRequest.path), "utf8"), stateBefore);
    assert.equal((await readdir(dirname(prepared.reviewRequest.path))).length, 1);
  });
}

for (const change of ["source", "guidance", "inventory", "provider", "contract", "standard"]) {
  test(`when ${change} changes after acceptance, reuse prepares fresh proof rather than returning PASS`, async t => {
    // Arrange
    const { root, packagePath, options } = await fixture(t);
    const prepared = await prepareSemanticEvaluation(options);
    const accepted = await complete(options, prepared);
    if (change === "source") await writeFile(join(root, "src/helper.js"), "export const helper = 2;\n");
    else if (change === "guidance") await writeFile(join(root, "AGENTS.md"), "Use an explicit ownership boundary.\n");
    else if (change === "inventory") await writeFile(join(root, "src/new-caller.js"), "export const consumer = 'helper';\n");
    else if (change === "standard") await writeFile(join(packagePath, "standard.md"), "Changed modules own tested behavior.\n");
    else {
      const filePath = join(packagePath, change === "provider" ? "package.json" : "contract.json");
      const document = JSON.parse(await readFile(filePath, "utf8"));
      if (change === "provider") document.version = "1.0.1";
      else document.gold = "Own tested meaningful behavior.";
      await writeFile(filePath, JSON.stringify(document));
    }

    // Act
    const refreshed = await prepareSemanticEvaluation({ ...options, reuseExisting: true });

    // Assert
    assert.equal(accepted.status, "PASS");
    assert.equal(refreshed.status, "PENDING");
    assert.notEqual(refreshed.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.notEqual(refreshed.reviewRequest.nonce, prepared.reviewRequest.nonce);
  });
}

for (const change of ["expanded", "narrowed", "automatic", "source limit", "recovery policy", "context selectors", "provider path", "owning root"]) {
  test(`when the requested ${change} scope differs, accepted proof is not reused`, async t => {
    // Arrange
    const { root, packagePath, options } = await fixture(t);
    const initialOptions = change === "narrowed" ? { ...options, changedPaths: ["src/helper.js", "src/caller.js"] } : options;
    const prepared = await prepareSemanticEvaluation(initialOptions);
    const accepted = await complete(options, prepared);
    let changedOptions = { ...options, reuseExisting: true };
    if (change === "expanded") changedOptions.changedPaths = ["src/helper.js", "src/caller.js"];
    else if (change === "automatic") changedOptions.automaticScope = { packageDirectory: join(root, "plugins"), delivery: { baseRef: "HEAD" } };
    else if (change === "source limit") changedOptions.maxSourceBytes = 32_000;
    else if (change === "recovery policy") changedOptions.sourceRecovery = RECOVERY;
    else if (change === "context selectors") changedOptions.contextPaths = ["src/caller.js#L1-L1"];
    else if (change === "provider path") {
      const manifestPath = join(packagePath, "alternate.json");
      await writeFile(manifestPath, await readFile(options.check.manifestPath));
      changedOptions.check = { ...options.check, manifestPath };
    } else if (change === "owning root") {
      const other = await fixture(t);
      changedOptions = { ...other.options, check: options.check, reuseExisting: true };
    }

    // Act
    const refreshed = await prepareSemanticEvaluation(changedOptions);

    // Assert
    assert.equal(accepted.status, "PASS");
    assert.equal(refreshed.status, "PENDING");
    assert.notEqual(refreshed.reviewRequest.requestId, prepared.reviewRequest.requestId);
    assert.deepEqual(refreshed.reviewRequest.scope.changedPaths, [...changedOptions.changedPaths].sort());
  });
}

for (const reuseExisting of [undefined, false]) {
  test(`when manual preparation uses reuseExisting=${reuseExisting}, accepted proof is replaced by a fresh request`, async t => {
    // Arrange
    const { options } = await fixture(t);
    const prepared = await prepareSemanticEvaluation(options);
    const accepted = await complete(options, prepared);

    // Act
    const fresh = await prepareSemanticEvaluation({ ...options, ...(reuseExisting === undefined ? {} : { reuseExisting }) });

    // Assert
    assert.equal(accepted.status, "PASS");
    assert.equal(fresh.status, "PENDING");
    assert.notEqual(fresh.reviewRequest.requestId, prepared.reviewRequest.requestId);
  });
}

for (const damage of ["request missing", "request tampered", "state missing", "state malformed", "result missing", "result tampered"]) {
  test(`when prior ${damage}, preparation establishes a fresh request instead of reusable proof`, async t => {
    // Arrange
    const { options } = await fixture(t);
    const prepared = await prepareSemanticEvaluation(options);
    const accepted = await complete(options, prepared);
    const statePath = stateFile(prepared.reviewRequest.path);
    if (damage === "request missing") await rm(prepared.reviewRequest.path);
    else if (damage === "request tampered") await writeFile(prepared.reviewRequest.path, "{}");
    else if (damage === "state missing") await rm(statePath);
    else if (damage === "state malformed") await writeFile(statePath, "{");
    else {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (damage === "result missing") delete state.finalResult;
      else state.finalResult.id = "publisher:forged";
      await writeFile(statePath, JSON.stringify(state));
    }

    // Act
    const fresh = await prepareSemanticEvaluation({ ...options, reuseExisting: true });

    // Assert
    assert.equal(accepted.status, "PASS");
    assert.equal(fresh.status, "PENDING");
    assert.notEqual(fresh.reviewRequest.requestId, prepared.reviewRequest.requestId);
  });
}

test("when an unassessed request exists, reuse does not fabricate a final assessment", async t => {
  // Arrange
  const { options } = await fixture(t);
  const prepared = await prepareSemanticEvaluation(options);

  // Act
  const fresh = await prepareSemanticEvaluation({ ...options, reuseExisting: true });

  // Assert
  assert.equal(fresh.status, "PENDING");
  assert.notEqual(fresh.reviewRequest.requestId, prepared.reviewRequest.requestId);
});

for (const changedMaterial of [false, true]) {
  test(`when recovered caller and external material is ${changedMaterial ? "changed" : "unchanged"}, reuse validates the complete enrolled capture`, async t => {
    // Arrange
    const { root, options } = await fixture(t);
    t.mock.method(globalThis, "fetch", async () => new Response("Authoritative runtime contract.\n"));
    const prepared = await prepareSemanticEvaluation(options);
    const recovered = await readSemanticEvaluation({
      cwd: root, requestPath: prepared.reviewRequest.path,
      contextPaths: ["AGENTS.md#L1-L1"], callerContextPaths: ["src/caller.js#L1-L1"], externalContextPaths: [EXTERNAL_URL],
    });
    const accepted = await complete(options, recovered, "PASS", [
      { path: "src/helper.js", line: 1, quote: SOURCE.trim() },
      { path: "src/caller.js", line: 1, quote: CALLER.trim() },
      { path: EXTERNAL_URL, line: 1, quote: "Authoritative runtime contract." },
    ]);
    if (changedMaterial) {
      await writeFile(join(root, "src/caller.js"), "export const runtime = 'other';\n");
      await writeFile(join(root, "AGENTS.md"), "Updated ownership guidance.\n");
    } else {
      t.mock.method(globalThis, "fetch", async () => { throw new Error("immutable snapshot must not refetch during reuse"); });
    }

    // Act
    const result = await prepareSemanticEvaluation({
      ...options, reuseExisting: true,
      ...(changedMaterial ? { contextPaths: ["src/helper.js#L1-L1"] } : {}),
    });

    // Assert
    assert.equal(accepted.status, "PASS");
    assert.deepEqual(recovered.reviewRequest.scope.contextPaths, ["AGENTS.md#L1-L1"]);
    assert.deepEqual(recovered.reviewRequest.scope.callerContextPaths, ["src/caller.js#L1-L1"]);
    assert.deepEqual(recovered.reviewRequest.scope.externalContextPaths, [EXTERNAL_URL]);
    if (changedMaterial) {
      assert.equal(result.status, "PENDING");
      assert.notEqual(result.reviewRequest.requestId, recovered.reviewRequest.requestId);
      assert.deepEqual(result.reviewRequest.scope.contextPaths, ["AGENTS.md#L1-L1", "src/helper.js#L1-L1"]);
      assert.deepEqual(result.reviewRequest.scope.callerContextPaths, ["src/caller.js#L1-L1"]);
      assert.deepEqual(result.reviewRequest.scope.externalContextPaths, [EXTERNAL_URL]);
      assert.equal(result.reviewRequest.context.targetedContext.find(record => record.path === "src/caller.js").content, "export const runtime = 'other';");
      assert.equal(result.reviewRequest.context.targetedContext.find(record => record.path === "AGENTS.md").content, "Updated ownership guidance.");
      assert.equal(result.reviewRequest.context.externalContext[0].content, "Authoritative runtime contract.\n");
    } else {
      assert.deepEqual(result, accepted);
      assert.equal(result.evaluation.requestId, recovered.reviewRequest.requestId);
    }
  });
}

test("when whole-source recovery is unchanged, its accepted result is reusable only with the same recovery policy", async t => {
  // Arrange
  const source = Array.from({ length: 700 }, (_, index) => `export const value${index} = ${index};`).join("\n");
  const { options } = await fixture(t, { source });
  const recoveryOptions = { ...options, sourceRecovery: RECOVERY };
  const prepared = await prepareSemanticEvaluation(recoveryOptions);
  const accepted = await complete(options, prepared, "PASS", [{ path: "src/helper.js", line: 1, quote: "export const value0 = 0;" }]);

  // Act
  const reused = await prepareSemanticEvaluation({ ...recoveryOptions, reuseExisting: true });
  const refreshed = await prepareSemanticEvaluation({ ...recoveryOptions, reuseExisting: true, sourceRecovery: { ...RECOVERY, chunkBytes: 8_000 } });

  // Assert
  assert.equal(accepted.status, "PASS");
  assert.equal(prepared.reviewRequest.context.changedCodeCoverage[0].complete, true);
  assert.deepEqual(reused, accepted);
  assert.equal(refreshed.status, "PENDING");
  assert.notEqual(refreshed.reviewRequest.requestId, prepared.reviewRequest.requestId);
});

test("when the current provider cannot execute capture, invalid prior proof does not mask the BLOCKED failure", async t => {
  // Arrange
  const { options } = await fixture(t);
  const prepared = await prepareSemanticEvaluation(options);
  const accepted = await complete(options, prepared);
  await rm(options.check.manifestPath);

  // Act
  const result = await prepareSemanticEvaluation({ ...options, reuseExisting: true });

  // Assert
  assert.equal(accepted.status, "PASS");
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /plugin manifest is unavailable/);
});

test("when one check needs fresh proof, unrelated check state remains intact", async t => {
  // Arrange
  const { options } = await fixture(t);
  const prepared = await prepareSemanticEvaluation(options);
  const accepted = await complete(options, prepared);
  const unrelatedPath = join(dirname(stateFile(prepared.reviewRequest.path)), "unrelated.json");
  const unrelatedState = JSON.stringify({ requestId: "owned-by-another-check", consumed: true });
  await writeFile(unrelatedPath, unrelatedState);

  // Act
  const result = await prepareSemanticEvaluation({ ...options, reuseExisting: true, maxSourceBytes: 32_000 });

  // Assert
  assert.equal(accepted.status, "PASS");
  assert.equal(result.status, "PENDING");
  assert.equal(await readFile(unrelatedPath, "utf8"), unrelatedState);
});

for (const difference of ["incidental metadata", "base", "merge base", "base reference", "selected paths", "provider directory", "work level", "manual scope"]) {
  test(`when automatic ${difference} changes, reuse depends on selected evidence and delivery base rather than incidental metadata`, async t => {
    // Arrange
    const { root, options } = await fixture(t);
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "baseline");
    const baseRef = git("rev-parse", "HEAD");
    await writeFile(join(root, "src/helper.js"), `${SOURCE}export const additional = true;\n`);
    git("add", ".");
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "delivery");
    const delivery = await captureDeliveryScope({ repositoryRoot: root, baseRef, candidatePaths: options.changedPaths });
    const automaticScope = { packageDirectory: join(root, "plugins"), delivery };
    const prepared = await prepareSemanticEvaluation({ ...options, automaticScope });
    const accepted = await complete(options, prepared);
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--allow-empty", "-qm", "unrelated delivery metadata");
    const nextDelivery = {
      ...await captureDeliveryScope({ repositoryRoot: root, baseRef, candidatePaths: [...options.changedPaths, "unrelated/notes.txt"] }),
      changedPaths: [...delivery.changedPaths, "unrelated/notes.txt"],
    };
    const nextScope = { ...automaticScope, delivery: nextDelivery };
    const nextOptions = { ...options, reuseExisting: true, automaticScope: nextScope };
    if (difference === "base") nextDelivery.baseCommit = git("rev-parse", "HEAD");
    else if (difference === "merge base") nextDelivery.mergeBaseCommit = git("rev-parse", "HEAD");
    else if (difference === "base reference") nextDelivery.baseRef = "HEAD~2";
    else if (difference === "selected paths") nextOptions.changedPaths = ["src/helper.js", "src/caller.js"];
    else if (difference === "provider directory") nextScope.packageDirectory = join(root, "other-plugins");
    else if (difference === "work level") nextScope.workLevel = "quick-tweak";
    else if (difference === "manual scope") delete nextOptions.automaticScope;

    // Act
    const result = await prepareSemanticEvaluation(nextOptions);

    // Assert
    assert.equal(accepted.status, "PASS");
    assert.notEqual(nextDelivery.headCommit, delivery.headCommit);
    assert.notDeepEqual(nextDelivery.candidatePaths, delivery.candidatePaths);
    assert.notDeepEqual(nextDelivery.changedPaths, delivery.changedPaths);
    if (difference === "incidental metadata") {
      assert.deepEqual(result, accepted);
      assert.equal(result.evaluation.requestId, prepared.reviewRequest.requestId);
    } else {
      assert.equal(result.status, "PENDING");
      assert.notEqual(result.reviewRequest.requestId, prepared.reviewRequest.requestId);
    }
  });
}
