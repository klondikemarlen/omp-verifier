import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

  try {
    await writeFile(
      checkPath,
      'process.stdout.write(JSON.stringify({ status: "PASS", summary: "Node ran the check" }));\n',
    );

    const runtimeCheck = {
      id: "runtime:node",
      entryPath: checkPath,
      timeoutMs: 1_000,
    };
    process.execPath = "missing-omp-runtime";

    // Act
    const result = await runVerificationCheck(runtimeCheck, checkDirectory);

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

test("when Git metadata is unavailable, automatic CLI reports a blocked result", async () => {
  // Arrange
  const projectDirectory = await mkdtemp(join(tmpdir(), "omp-verifier-cli-"));

  try {
    // Act
    let exitCode;
    let results;
    try {
      execFileSync(process.execPath, [join(process.cwd(), "bin", "omp-verifier.js"), "automatic"], {
        cwd: projectDirectory,
        encoding: "utf8",
      });
    } catch (error) {
      exitCode = error.status;
      results = JSON.parse(error.stdout);
    }

    // Assert
    assert.deepEqual({
      exitCode,
      result: {
        id: results[0]?.id,
        status: results[0]?.status,
        summary: results[0]?.summary,
        hasEvidence: typeof results[0]?.evidence === "string",
      },
    }, {
      exitCode: 1,
      result: {
        id: "verifier:auto-selection",
        status: "BLOCKED",
        summary: "Could not inspect changed paths",
        hasEvidence: true,
      },
    });
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
