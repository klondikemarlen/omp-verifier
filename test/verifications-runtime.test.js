import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("when no automatic checks are installed, automatic CLI emits an empty result", async () => {
  // Arrange
  const projectDirectory = await mkdtemp(join(tmpdir(), "omp-verifier-cli-"));
  const agentDirectory = join(projectDirectory, "agent");

  try {
    // Act
    const output = execFileSync(process.execPath, [join(process.cwd(), "bin", "omp-verifier.js"), "automatic"], {
      cwd: projectDirectory,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
    });

    // Assert
    assert.deepEqual(JSON.parse(output), []);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});

test("when automatic CLI receives explicit paths, ignores stale worktree paths unless explicitly requested", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-cli-paths-"));
  const agentDirectory = join(root, "agent");
  const packageDirectory = join(root, "plugins", "node_modules", "publisher");
  const projectDirectory = join(root, "project");
  const runAutomatic = paths => {
    try {
      return { exitCode: 0, output: execFileSync(process.execPath, [join(process.cwd(), "bin", "omp-verifier.js"), "automatic", ...paths], {
        cwd: projectDirectory,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
      }) };
    } catch (error) {
      return { exitCode: error.status, output: error.stdout };
    }
  };

  try {
    await mkdir(join(projectDirectory, "src"), { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(projectDirectory, "src", "stale.ts"), "export {};\n");
    for (const args of [["init", "--quiet"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"], ["add", "."], ["commit", "--quiet", "-m", "baseline"]]) {
      execFileSync("git", args, { cwd: projectDirectory });
    }
    await writeFile(join(projectDirectory, "src", "stale.ts"), "export {};\n// stale\n");
    await writeFile(join(projectDirectory, "now.cwli"), "fields @message\n");
    await writeFile(join(root, "plugins", "package.json"), JSON.stringify({
      name: "omp-plugins",
      dependencies: { publisher: "1.0.0" },
    }));
    await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: "publisher",
      omp: {
        extensions: ["./index.js"],
        verifications: [{
          id: "publisher:typescript",
          label: "TypeScript check",
          description: "Fails when selected",
          entry: "./check.mjs",
          pathTriggers: ["**/*.ts"],
        }],
      },
    }));
    await writeFile(join(packageDirectory, "check.mjs"), 'process.stdout.write(JSON.stringify({ status: "FAIL", summary: "fixture failure" })); process.exitCode = 1;\n');

    // Act
    const unrelated = runAutomatic(["now.cwli"]);
    await writeFile(join(projectDirectory, "src", "current.ts"), "export {};\n");
    const current = runAutomatic(["src/current.ts"]);
    const worktree = runAutomatic(["--worktree"]);

    // Assert
    assert.deepEqual({ exitCode: unrelated.exitCode, results: JSON.parse(unrelated.output) }, { exitCode: 0, results: [] });
    assert.deepEqual({ exitCode: current.exitCode, matches: JSON.parse(current.output)[0].matches }, {
      exitCode: 1,
      matches: [{ path: "src/current.ts", trigger: "**/*.ts" }],
    });
    assert.equal(JSON.parse(worktree.output)[0].matches.some(match => match.path === "src/stale.ts"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
