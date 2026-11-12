import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { discoverVerificationChecks } from "#root/omp-plugin/verifications.js";

import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
} from "#root/omp-plugin/semantic-evaluations.js";

const CLI = join(process.cwd(), "bin", "omp-verifier.js");

async function createSemanticFixture() {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-supersession-"));
  const packageDirectory = join(root, "plugins");
  const provider = join(packageDirectory, "publisher");
  await mkdir(provider, { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "helper.js"), "export function helper(value) { return value; }\n");
  await writeFile(join(root, "src", "caller.js"), 'import { helper } from "./helper.js";\nexport const result = helper(1);\n');
  await writeFile(join(provider, "standard.md"), "The changed module implements the supplied helper contract.\n");
  await writeFile(join(provider, "contract.json"), JSON.stringify({
    version: 1,
    standardId: "publisher:alignment",
    source: "./standard.md",
    gold: "The changed helper returns its argument.",
    requiredContext: ["changed-code"],
    rubric: [{ id: "identity", question: "Does the helper return its argument?" }],
  }));
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher",
    version: "1.0.0",
    omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: "publisher:alignment",
        label: "Helper Contract",
        description: "Assesses the supplied helper contract.",
        mode: "agentic",
        contract: "./contract.json",
      }],
    },
  }));
  return { root, packageDirectory };
}

async function discoverSemanticCheck(fixture) {
  const { checks } = await discoverVerificationChecks({ packageDirectory: fixture.packageDirectory });
  return checks.find(check => check.id === "publisher:alignment");
}

function passAssessment(requestId) {
  return {
    requestId,
    status: "PASS",
    summary: "The helper implements its identity contract.",
    rationale: "The captured helper returns its argument unchanged.",
    citations: [{ path: "src/helper.js", line: 1, quote: "export function helper(value) { return value; }" }],
  };
}

test("when a superseded operation arrives after current completion, it cannot replay a verdict", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const current = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: current.reviewRequest.path,
      assessment: passAssessment(current.reviewRequest.requestId),
    });

    // Act
    const late = await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: first.reviewRequest.path,
      assessment: passAssessment(first.reviewRequest.requestId),
    });

    // Assert
    assert.equal(late.status, "SUPERSEDED");
    assert.equal(late.evaluation.requestId, first.reviewRequest.requestId);
    assert.equal(late.evaluation.supersededBy, current.reviewRequest.requestId);
    assert.equal(late.reviewRequest, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when the replacement request is stale, supersession does not hide the missing current evidence", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    await writeFile(join(fixture.root, "src", "helper.js"), "export const updated = true;\n");

    // Act
    const late = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: first.reviewRequest.path,
    });

    // Assert
    assert.equal(late.status, "BLOCKED");
    assert.equal(late.reviewRequest, undefined);
    assert.match(late.evidence, /source or project context changed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a late read includes old context selectors, it returns the replacement scope without modifying it", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const current = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js", "src/caller.js"],
    });

    // Act
    const late = await readSemanticEvaluation({
      cwd: fixture.root,
      requestPath: first.reviewRequest.path,
      contextPaths: ["obsolete-selector.js"],
    });

    // Assert
    assert.equal(late.reviewRequest.requestId, current.reviewRequest.requestId);
    assert.deepEqual(late.reviewRequest.scope.changedPaths, ["src/caller.js", "src/helper.js"]);
    assert.deepEqual(late.reviewRequest.scope.contextPaths, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a late CLI assessment follows replacement completion, failure-only output preserves its non-verdict lifecycle", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const current = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    await completeSemanticEvaluation({
      cwd: fixture.root,
      requestPath: current.reviewRequest.path,
      assessment: passAssessment(current.reviewRequest.requestId),
    });

    // Act
    const late = spawnSync(process.execPath, [
      CLI, "evaluate", first.reviewRequest.path,
      "--assessment", JSON.stringify(passAssessment(first.reviewRequest.requestId)),
      "--failures-only",
    ], { cwd: fixture.root, encoding: "utf8" });

    // Assert
    assert.equal(late.status, 0);
    const result = JSON.parse(late.stdout)[0];
    assert.equal(result.status, "SUPERSEDED");
    assert.equal(result.evaluation.supersededBy, current.reviewRequest.requestId);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("when a late CLI page read follows supersession, replacement inspection starts at page zero", async () => {
  // Arrange
  const fixture = await createSemanticFixture();

  try {
    const check = await discoverSemanticCheck(fixture);
    const first = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });
    const current = await prepareSemanticEvaluation({
      check,
      cwd: fixture.root,
      changedPaths: ["src/helper.js"],
    });

    // Act
    const late = spawnSync(process.execPath, [
      CLI, "review", first.reviewRequest.path,
      "--reporter", "text", "--page", "4",
    ], { cwd: fixture.root, encoding: "utf8" });

    // Assert
    assert.equal(late.status, 0);
    assert.ok(late.stdout.includes(`Request ID: ${current.reviewRequest.requestId}\n`));
    assert.match(late.stdout, /Page index: 0 of 1 /);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const status of ["PASS", "FAIL", "BLOCKED"]) {
  test(`when an accepted ${status} is retried or read, its exact result survives a conflicting draft`, async () => {
    // Arrange
    const fixture = await createSemanticFixture();
    try {
      const prepared = await prepareSemanticEvaluation({
        check: await discoverSemanticCheck(fixture),
        cwd: fixture.root,
        changedPaths: ["src/helper.js"],
      });
      const requestPath = prepared.reviewRequest.path;
      const assessment = { ...passAssessment(prepared.reviewRequest.requestId), status };
      const accepted = await completeSemanticEvaluation({ cwd: fixture.root, requestPath, assessment });
      const conflicting = { ...assessment, status: status === "PASS" ? "FAIL" : "PASS", summary: "Replacement draft" };

      // Act
      const retried = await completeSemanticEvaluation({ cwd: fixture.root, requestPath, assessment: conflicting });
      const recovered = await readSemanticEvaluation({ cwd: fixture.root, requestPath });
      const cli = spawnSync(process.execPath, [
        CLI, "evaluate", requestPath, "--assessment", "-", "--reporter", "text", "--failures-only",
      ], { cwd: fixture.root, encoding: "utf8", input: JSON.stringify(conflicting) });

      // Assert
      assert.deepEqual({
        status: accepted.status,
        retried,
        recovered,
        cliStatus: cli.status,
        cliReport: status === "PASS" ? cli.stdout : cli.stdout.startsWith(`${status} publisher:alignment\n`),
      }, {
        status,
        retried: accepted,
        recovered: accepted,
        cliStatus: status === "PASS" ? 0 : 1,
        cliReport: status === "PASS" ? "" : true,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const mutation of ["source", "standard", "request", "missing provider", "legacy completion"]) {
  test(`when ${mutation} invalidates a completed request, recovery cannot reuse its PASS`, async () => {
    // Arrange
    const fixture = await createSemanticFixture();
    try {
      const prepared = await prepareSemanticEvaluation({
        check: await discoverSemanticCheck(fixture),
        cwd: fixture.root,
        changedPaths: ["src/helper.js"],
      });
      const requestPath = prepared.reviewRequest.path;
      const assessment = passAssessment(prepared.reviewRequest.requestId);
      await completeSemanticEvaluation({ cwd: fixture.root, requestPath, assessment });
      const provider = join(fixture.packageDirectory, "publisher");
      const expectedEvidence = {
        source: /source or project context changed/,
        standard: /standard or provider manifest changed/,
        request: /tampered/,
        "missing provider": /manifest is unavailable/,
        "legacy completion": /no retained final result/,
      };
      if (mutation === "source") {
        await writeFile(join(fixture.root, "src/helper.js"), "export function helper() { return 0; }\n");
      } else if (mutation === "standard") {
        await writeFile(join(provider, "standard.md"), "The helper must return zero.\n");
      } else if (mutation === "request") {
        await writeFile(requestPath, `${await readFile(requestPath, "utf8")}\n`);
      } else if (mutation === "missing provider") {
        await rm(join(provider, "package.json"));
      } else {
        const states = join(dirname(dirname(requestPath)), "states");
        const statePath = join(states, (await readdir(states))[0]);
        const state = JSON.parse(await readFile(statePath, "utf8"));
        delete state.finalResult;
        await writeFile(statePath, JSON.stringify(state));
      }

      // Act
      const recovered = await readSemanticEvaluation({ cwd: fixture.root, requestPath });
      const retried = await completeSemanticEvaluation({ cwd: fixture.root, requestPath, assessment });

      // Assert
      assert.deepEqual([recovered, retried].map(result => ({
        status: result.status,
        evidenceMatches: expectedEvidence[mutation].test(result.evidence),
        request: result.reviewRequest,
      })), [
        { status: "BLOCKED", evidenceMatches: true, request: undefined },
        { status: "BLOCKED", evidenceMatches: true, request: undefined },
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}
