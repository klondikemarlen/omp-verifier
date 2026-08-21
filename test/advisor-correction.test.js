import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installGlobalVerifier } from "#@/omp-plugin/global-verifier.js";

test("when an automatic check fails, verifier setup gives the advisor correction evidence", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-advisor-spec-"));
  const agentDir = join(root, "agent");
  const packageDir = join(root, "plugins", "node_modules", "publisher");
  const projectDir = join(root, "project");
  const checkPath = join(packageDir, "fail.mjs");

  try {
    await mkdir(join(projectDir, "src"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(projectDir, "src", "changed.js"), "export {};\n");
    await writeFile(join(root, "plugins", "package.json"), JSON.stringify({
      name: "omp-plugins",
      dependencies: { publisher: "1.0.0" },
    }));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "publisher",
      omp: {
        extensions: ["./index.js"],
        verifications: [{
          id: "publisher:fail",
          label: "Failing check",
          description: "Fails for advisor correction",
          entry: "./fail.mjs",
          pathTriggers: ["src/**"],
        }],
      },
    }));
    await writeFile(checkPath, 'process.stdout.write(JSON.stringify({ status: "FAIL", summary: "Fixture failed", evidence: "fixture evidence", nextCheck: "fix fixture" })); process.exitCode = 1;\n');
    execFileSync("git", ["init", "--quiet"], { cwd: projectDir });

    // Act
    let exitCode;
    let results;
    try {
      execFileSync(process.execPath, [join(process.cwd(), "bin", "omp-verifier.js"), "automatic", "src/changed.js"], {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      });
    } catch (error) {
      exitCode = error.status;
      results = JSON.parse(error.stdout);
    }
    await installGlobalVerifier({ agentDir });
    const roster = await readFile(join(agentDir, "WATCHDOG.yml"), "utf8");
    const guidance = await readFile(join(agentDir, "verifier", "WATCHDOG.md"), "utf8");

    // Assert
    assert.deepEqual({
      exitCode,
      result: results[0],
      hasBash: roster.includes("tools: [bash]"),
      hasBlockerRule: guidance.includes("call `advise` with severity `blocker`"),
      hasCoordinatorCommand: guidance.includes("`automatic` is the packaged coordinator command"),
      hasInstalledCli: guidance.includes(join(process.cwd(), "bin", "omp-verifier.js")),
    }, {
      exitCode: 1,
      result: {
        id: "publisher:fail",
        status: "FAIL",
        summary: "Fixture failed",
        evidence: "fixture evidence",
        nextCheck: "fix fixture",
        matches: [{ path: "src/changed.js", trigger: "src/**" }],
      },
      hasBash: true,
      hasBlockerRule: true,
      hasCoordinatorCommand: true,
      hasInstalledCli: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
