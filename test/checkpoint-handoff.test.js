import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  completeSemanticEvaluation,
  prepareSemanticEvaluation,
  readSemanticEvaluation,
} from "#root/omp-plugin/semantic-evaluations.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";

import { resumeCheckpoint } from "#root/omp-plugin/checkpoint-handoff.js";

const VALUE_CHECK_MANIFEST = {
  name: "publisher",
  version: "1.0.0",
  omp: {
    extensions: ["./index.js"],
    verifications: [{
      id: "publisher:nonnegative",
      mode: "agentic",
      label: "Nonnegative Values",
      description: "Check exported values against the lower bound.",
      contract: "./contract.json",
    }],
  },
};
const NONNEGATIVE_CONTRACT = {
  version: 1,
  standardId: "publisher:nonnegative",
  source: "./standard.md",
  gold: "Exported values must be nonnegative.",
  requiredContext: ["changed-code"],
  rubric: [{
    id: "minimum",
    question: "Is the exported value at least zero?",
  }],
};
const VALUE_REVIEW = {
  status: "PASS",
  summary: "The exported value is nonnegative.",
  rationale: "The only exported value is zero, which meets the lower bound.",
  citations: [{
    path: "value.js",
    line: 1,
    quote: "export const value = 0;",
  }],
};

async function commitBaseline(t, files) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-checkpoint-handoff-"));
  t.after(() => rm(cwd, {
    recursive: true,
    force: true,
  }));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(cwd, name);
    await mkdir(dirname(path), {
      recursive: true,
    });
    await writeFile(path, contents);
  }

  const options = {
    cwd,
  };
  execFileSync("git", ["init", "--quiet"], options);
  execFileSync("git", ["add", "."], options);
  execFileSync("git", ["-c", "user.name=Verifier Tests", "-c", "user.email=tests@example.invalid", "commit", "--quiet", "-m", "baseline"], options);
  return cwd;
}

async function installedCheck(cwd, id) {
  const { checks } = await discoverVerificationChecks({
    packageDirectory: join(cwd, "plugins"),
  });
  return checks.find(check => check.id === id);
}

test("when a fresh session exits without assessing the aggregate, the checkpoint remains pending", async t => {
  // Arrange
  const cwd = await commitBaseline(t, {
    "plugins/publisher/package.json": JSON.stringify(VALUE_CHECK_MANIFEST),
    "plugins/publisher/contract.json": JSON.stringify(NONNEGATIVE_CONTRACT),
    "plugins/publisher/standard.md": "Values must be nonnegative.\n",
    "value.js": "export const value = 0;\n",
  });
  const initial = await prepareSemanticEvaluation({
    cwd,
    check: await installedCheck(cwd, "publisher:nonnegative"),
    changedPaths: ["value.js"],
  });
  const batch = await readSemanticEvaluation({
    cwd,
    requestPath: initial.reviewRequest.path,
    continuation: true,
  });
  const { requestId, path: requestPath } = batch.reviewRequest;
  await completeSemanticEvaluation({
    cwd,
    requestPath,
    assessment: {
      ...VALUE_REVIEW,
      requestId,
      batchIndex: 0,
      crossBatchNotes: "This batch covers the only exported value.",
    },
  });

  // Act
  const result = await resumeCheckpoint({
    cwd,
    requestPath,
  }, async () => {});

  // Assert
  assert.equal(result.status, "PENDING");
  assert.equal(result.reviewRequest.requestId, requestId);
  assert.equal(result.reviewRequest.continuation.phase, "aggregate");
  assert.equal(result.reviewRequest.continuation.batches[0].assessment.status, "PASS");
});

test("when the origin also assesses during a handoff, only the fresh reviewer's verdict is accepted", async t => {
  // Arrange
  const cwd = await commitBaseline(t, {
    "plugins/publisher/package.json": JSON.stringify(VALUE_CHECK_MANIFEST),
    "plugins/publisher/contract.json": JSON.stringify(NONNEGATIVE_CONTRACT),
    "plugins/publisher/standard.md": "Values must be nonnegative.\n",
    "value.js": "export const value = 0;\n",
  });
  const initial = await prepareSemanticEvaluation({
    cwd,
    check: await installedCheck(cwd, "publisher:nonnegative"),
    changedPaths: ["value.js"],
  });
  const batch = await readSemanticEvaluation({
    cwd,
    requestPath: initial.reviewRequest.path,
    continuation: true,
  });
  const { requestId, path: requestPath } = batch.reviewRequest;
  await completeSemanticEvaluation({
    cwd,
    requestPath,
    assessment: {
      ...VALUE_REVIEW,
      requestId,
      batchIndex: 0,
      crossBatchNotes: "This batch covers the only exported value.",
    },
  });
  const aggregateAssessment = {
    ...VALUE_REVIEW,
    requestId,
    coveredBatches: [0],
  };
  const cli = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
  let originatingResult;

  // Act
  const result = await resumeCheckpoint({
    cwd,
    requestPath,
  }, async () => {
    originatingResult = await completeSemanticEvaluation({
      cwd,
      requestPath,
      assessment: aggregateAssessment,
    });
    execFileSync(process.execPath, [cli, "evaluate", requestPath, "--assessment", "-"], {
      cwd,
      env: {
        ...process.env,
        OMP_VERIFIER_FRESH_REVIEWER: requestPath,
      },
      input: JSON.stringify({
        ...aggregateAssessment,
        summary: "Fresh review confirms the nonnegative value.",
      }),
    });
  });

  // Assert
  assert.equal(originatingResult.status, "PENDING");
  assert.equal(result.status, "PASS");
  assert.equal(result.summary, "Fresh review confirms the nonnegative value.");
});

test("when a handoff is attempted before a checkpoint, dispatch is refused", async t => {
  // Arrange
  const cwd = await commitBaseline(t, {
    "plugins/publisher/package.json": JSON.stringify(VALUE_CHECK_MANIFEST),
    "plugins/publisher/contract.json": JSON.stringify(NONNEGATIVE_CONTRACT),
    "plugins/publisher/standard.md": "Values must be nonnegative.\n",
    "value.js": "export const value = 0;\n",
  });
  const initial = await prepareSemanticEvaluation({
    cwd,
    check: await installedCheck(cwd, "publisher:nonnegative"),
    changedPaths: ["value.js"],
  });
  const batch = await readSemanticEvaluation({
    cwd,
    requestPath: initial.reviewRequest.path,
    continuation: true,
  });

  // Act
  const handoff = resumeCheckpoint({
    cwd,
    requestPath: batch.reviewRequest.path,
  }, () => assert.fail("Dispatched before the first checkpoint"));

  // Assert
  await assert.rejects(handoff, /requires an accepted batch checkpoint/);
});
