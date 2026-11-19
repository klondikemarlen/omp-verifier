import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCloseoutReceipts,
  MAX_CLOSEOUT_RECEIPTS,
} from "#root/omp-plugin/closeout-summary.js";

const repositoryRoot = "/work/repository";
const firstReceipt = "/tmp/private/first.json";
const secondReceipt = "/tmp/private/second.json";
const thirdReceipt = "/tmp/private/third.json";
const fourthReceipt = "/tmp/private/fourth.json";

function passingResource(id) {
  return {
    id,
    status: "PASS",
  };
}

function observedReceipt(status, dispositions) {
  let summary = "Declared resource dispositions match fresh observations";
  if (status !== "PASS") {
    summary = "Declared resource closeout is incomplete";
  }
  return {
    id: "verifier:resource-closeout",
    status,
    summary,
    dispositions,
  };
}

test("when exact receipt references repeat, each distinct receipt contributes its own observations once", async () => {
  // Arrange
  const receiptPaths = [firstReceipt, secondReceipt, firstReceipt];
  const firstResult = observedReceipt("PASS", [passingResource("sandbox")]);
  const secondResult = observedReceipt("PASS", [
    passingResource("sandbox"),
    passingResource("shared-environment"),
  ]);
  const calls = [];
  async function verifyReceipt(root, receiptPath) {
    calls.push([root, receiptPath]);
    if (receiptPath === firstReceipt) {
      return firstResult;
    }
    return secondResult;
  }

  // Act
  const result = await checkCloseoutReceipts({
    repositoryRoot,
    receiptPaths,
    verifyReceipt,
  });

  // Assert
  assert.deepEqual(calls, [
    [repositoryRoot, firstReceipt],
    [repositoryRoot, secondReceipt],
  ]);
  assert.deepEqual(result, {
    status: "PASS",
    checkedResources: 3,
    receipts: [
      {
        receiptPath: firstReceipt,
        status: "PASS",
        summary: "Declared resource dispositions match fresh observations",
      },
      {
        receiptPath: secondReceipt,
        status: "PASS",
        summary: "Declared resource dispositions match fresh observations",
      },
    ],
  });
});

test("when receipts contain failures and blockers, failures control without suppressing any independent check", async () => {
  // Arrange
  const deniedResource = {
    id: "container",
    status: "BLOCKED",
    evidence: "Docker daemon could not be reached",
  };
  const retainedResource = {
    id: "protected-environment",
    status: "FAIL",
    evidence: "Required retained resource is missing or changed",
  };
  const leftoverResource = {
    id: "sandbox",
    status: "FAIL",
    evidence: "Declared disposable resource remains present",
  };
  const blocked = observedReceipt("BLOCKED", [deniedResource]);
  const failed = observedReceipt("FAIL", [deniedResource, retainedResource, leftoverResource]);
  const passed = observedReceipt("PASS", [passingResource("primary-worktree")]);
  const results = new Map([
    [firstReceipt, blocked],
    [secondReceipt, failed],
    [thirdReceipt, passed],
  ]);

  // Act
  const result = await checkCloseoutReceipts({
    repositoryRoot,
    receiptPaths: [firstReceipt, secondReceipt, thirdReceipt],
    verifyReceipt: async (_root, receiptPath) => results.get(receiptPath),
  });

  // Assert
  assert.equal(result.status, "FAIL");
  assert.equal(result.checkedResources, 3);
  assert.deepEqual(result.receipts, [
    {
      receiptPath: firstReceipt,
      status: "BLOCKED",
      summary: "Declared resource closeout is incomplete",
      problem: "container: Docker daemon could not be reached",
    },
    {
      receiptPath: secondReceipt,
      status: "FAIL",
      summary: "Declared resource closeout is incomplete",
      problem: "protected-environment: Required retained resource is missing or changed",
    },
    {
      receiptPath: thirdReceipt,
      status: "PASS",
      summary: "Declared resource dispositions match fresh observations",
    },
  ]);
});

test("when receipt evidence is missing, malformed, or unavailable, it supplies no resource observations", async () => {
  // Arrange
  const missing = {
    id: "verifier:resource-closeout",
    status: "BLOCKED",
    summary: "Final resource disposition cannot be established",
    evidence: `ENOENT: no such file or directory, lstat '${firstReceipt}'`,
  };
  const malformed = observedReceipt("PASS", []);
  const passed = observedReceipt("PASS", [passingResource("sandbox")]);
  async function verifyReceipt(_root, receiptPath) {
    if (receiptPath === firstReceipt) {
      return missing;
    } else if (receiptPath === secondReceipt) {
      throw new Error(`Launcher unavailable for ${secondReceipt}.\n${"Extra details. ".repeat(50)}`);
    } else if (receiptPath === thirdReceipt) {
      return malformed;
    }
    return passed;
  }

  // Act
  const result = await checkCloseoutReceipts({
    repositoryRoot,
    receiptPaths: [firstReceipt, secondReceipt, thirdReceipt, fourthReceipt],
    verifyReceipt,
  });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.checkedResources, 1);
  const [missingReceipt, transportFailure, malformedReceipt, passedReceipt] = result.receipts;
  assert.deepEqual(missingReceipt, {
    receiptPath: firstReceipt,
    status: "BLOCKED",
    summary: "Final resource disposition cannot be established",
    problem: "ENOENT: no such file or directory, lstat '[receipt path]'",
  });
  assert.equal(transportFailure.status, "BLOCKED");
  assert.match(transportFailure.problem, /^Verifier could not return evidence: Launcher unavailable for \[receipt path\]\./u);
  assert.doesNotMatch(transportFailure.problem, /\n/u);
  assert.ok(transportFailure.problem.length <= 200);
  assert.ok(transportFailure.problem.endsWith("…"));
  assert.deepEqual(malformedReceipt, {
    receiptPath: thirdReceipt,
    status: "BLOCKED",
    summary: "No valid receipt evidence",
    problem: "Verifier returned invalid closeout evidence; rerun the closeout check with the installed verifier.",
  });
  assert.deepEqual(passedReceipt, {
    receiptPath: fourthReceipt,
    status: "PASS",
    summary: "Declared resource dispositions match fresh observations",
  });
});

test("when a request contains too many receipt references, no receipt is checked", async () => {
  // Arrange
  const receiptPaths = Array(MAX_CLOSEOUT_RECEIPTS + 1).fill(firstReceipt);
  let calls = 0;
  async function verifyReceipt() {
    calls += 1;
  }

  // Act / Assert
  await assert.rejects(checkCloseoutReceipts({
    repositoryRoot,
    receiptPaths,
    verifyReceipt,
  }), /Provide between 1 and 8/u);
  assert.equal(calls, 0);
});
