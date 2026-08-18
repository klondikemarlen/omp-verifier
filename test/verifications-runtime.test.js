import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runVerificationCheck } from "../omp-plugin/verifications.js";

test("when OMP has a non-Node executable, runs verification checks with Node", async () => {
  // Arrange
  const checkDirectory = await mkdtemp(join(tmpdir(), "omp-verifier-runtime-"));
  const checkPath = join(checkDirectory, "check.mjs");
  const originalExecutable = process.execPath;

  await writeFile(
    checkPath,
    'process.stdout.write(JSON.stringify({ status: "PASS", summary: "Node ran the check" }));\n',
  );

  process.execPath = "missing-omp-runtime";

  try {
    // Act
    const result = await runVerificationCheck({
      id: "runtime:node",
      entryPath: checkPath,
      timeoutMs: 1_000,
    }, checkDirectory);

    // Assert
    assert.deepEqual(result, {
      id: "runtime:node",
      status: "PASS",
      summary: "Node ran the check",
    });
  } finally {
    process.execPath = originalExecutable;
    await rm(checkDirectory, { recursive: true, force: true });
  }
});
