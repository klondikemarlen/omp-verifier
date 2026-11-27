import assert from "node:assert/strict";
import test from "node:test";

import { formatVerificationResults } from "#root/omp-plugin/reporters.js";

test("when checks fail or cannot run, text keeps their evidence and next check distinct", () => {
  // Arrange
  const results = [{
    id: "publisher:alignment",
    status: "FAIL",
    summary: "1 test-alignment violation found.",
    evidence: "tests/downloads.test.ts:169: missing ordered comments\nExpected Arrange, Act, Assert.",
    nextCheck: "Add ordered comments.\nRerun the check.",
    matches: [{ path: "tests/downloads.test.ts", trigger: "**/*.test.ts" }],
  }, {
    id: "publisher:database",
    status: "BLOCKED",
    summary: "Database is unavailable.",
  }];

  // Act
  const output = formatVerificationResults(results);

  // Assert
  assert.equal(output, `FAIL publisher:alignment
  1 test-alignment violation found.
  Evidence: tests/downloads.test.ts:169: missing ordered comments
  Expected Arrange, Act, Assert.
  Next check: Add ordered comments.
  Rerun the check.

BLOCKED publisher:database
  Database is unavailable.`);
});

test("when manual results pass or are suppressed, text does not mislabel them as failures", () => {
  // Arrange
  const results = [{ id: "publisher:pass", status: "PASS", summary: "Gold met." }, {
    id: "publisher:legacy",
    status: "SUPPRESSED",
    summary: "Automatic verification suppressed",
    evidence: "legacy/test.ts matched legacy/**: vendor-owned fixture",
  }];

  // Act
  const output = formatVerificationResults(results);

  // Assert
  assert.equal(output, `PASS publisher:pass
  Gold met.

SUPPRESSED publisher:legacy
  Automatic verification suppressed
  Evidence: legacy/test.ts matched legacy/**: vendor-owned fixture`);
});

test("when semantic verification fails, text identifies its governing standard and failed quality standard", () => {
  // Arrange
  const results = [{
    id: "publisher:module-boundary",
    status: "FAIL",
    summary: "The extracted accessor owns no independent boundary.",
    standard: {
      id: "publisher:module-boundary",
      source: "publisher/docs/organization.md#module-boundaries",
      gold: "An extraction owns a meaningful invariant or independently changing behavior.",
    },
    evidence: "src/account-name.js:2: return account.name;",
    nextCheck: "Inline the field selection and evaluate the corrected scope.",
  }];

  // Act
  const output = formatVerificationResults(results);

  // Assert
  assert.equal(output, `FAIL publisher:module-boundary
  The extracted accessor owns no independent boundary.
  Standard: publisher/docs/organization.md#module-boundaries
  Quality standard: An extraction owns a meaningful invariant or independently changing behavior.
  Evidence: src/account-name.js:2: return account.name;
  Next check: Inline the field selection and evaluate the corrected scope.`);
});

test("when the launcher supports exact request IDs, pending text offers a UUID resume command", t => {
  // Arrange
  const previousCapability = process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT;
  t.after(() => {
    if (previousCapability === undefined) delete process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT;
    else process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT = previousCapability;
  });
  process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT = "1";
  const result = {
    id: "publisher:alignment",
    status: "PENDING",
    summary: "Semantic evaluation is ready for assessment",
    reviewRequest: {
      requestId: "21883d11-72b1-4adc-98f0-ea1393b16c59",
      path: "/tmp/cache/8a3b6ed1-e1ef-417d-a0f4-398192821271.other-request.json",
    },
  };

  // Act
  const output = formatVerificationResults([result]);

  // Assert
  assert.ok(output.includes("  Review request: 21883d11-72b1-4adc-98f0-ea1393b16c59\n"));
  assert.ok(output.endsWith(" review '21883d11-72b1-4adc-98f0-ea1393b16c59' --resume --reporter text"));
  assert.doesNotMatch(output, /\/tmp\/cache\//);
});

test("when a pending result lacks a valid request ID, text retains its exact path even with launcher support", t => {
  // Arrange
  const previousCapability = process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT;
  t.after(() => {
    if (previousCapability === undefined) delete process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT;
    else process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT = previousCapability;
  });
  process.env.OMP_VERIFIER_REQUEST_ID_ARGUMENT = "1";
  const result = {
    id: "publisher:alignment",
    status: "PENDING",
    summary: "Semantic evaluation is ready for assessment",
    reviewRequest: {
      requestId: "21883d11-72b1-4adc-98f0-ea1393b16c59\n",
      path: "/tmp/cache/21883d11-72b1-4adc-98f0-ea1393b16c59.json",
    },
  };

  // Act
  const output = formatVerificationResults([result]);

  // Assert
  assert.ok(output.includes("  Review request: /tmp/cache/21883d11-72b1-4adc-98f0-ea1393b16c59.json\n"));
  assert.ok(output.endsWith(" review '/tmp/cache/21883d11-72b1-4adc-98f0-ea1393b16c59.json' --resume --reporter text"));
});
