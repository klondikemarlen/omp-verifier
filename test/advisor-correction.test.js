import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("when the install path contains shell syntax, generated guidance runs the literal coordinator after refresh", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-advisor-spec-"));
  const agentDir = join(root, "agent");
  const packageDir = join(root, "plugins", "node_modules", "publisher");
  const projectDir = join(root, "project");
  const checkPath = join(packageDir, "fail.mjs");
  const installedPackage = join(root, "verifier 'quoted' \"double\" $VERIFIER_PATH $(printf expanded) $& $$ $'replacement'");

  try {
    for (const entry of ["package.json", "WATCHDOG.md", "bin", "omp-plugin"]) {
      await cp(new URL(`../${entry}`, import.meta.url), join(installedPackage, entry), { recursive: true });
    }

    const { installGlobalVerifier } = await import(pathToFileURL(join(installedPackage, "omp-plugin", "global-verifier.js")));
    await mkdir(join(projectDir, "src"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(projectDir, "src", "changed.js"), "BROKEN\n");
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
    await writeFile(checkPath, `
import { readFileSync } from "node:fs";

const failed = readFileSync("src/changed.js", "utf8").includes("BROKEN");
process.stdout.write(JSON.stringify(failed
  ? { status: "FAIL", summary: "Fixture failed", evidence: "src/changed.js contains BROKEN", nextCheck: "remove BROKEN" }
  : { status: "PASS", summary: "Fixture repaired", evidence: "src/changed.js has no BROKEN marker" }));
process.exitCode = failed ? 1 : 0;
`);
    execFileSync("git", ["init", "--quiet"], { cwd: projectDir });

    // Act
    await installGlobalVerifier({ agentDir });
    await writeFile(join(agentDir, "verifier", "WATCHDOG.md"), "replaced generated guidance\n");
    await installGlobalVerifier({ agentDir });
    const guidance = await readFile(join(agentDir, "verifier", "WATCHDOG.md"), "utf8");
    const command = guidance.match(/`(node .+?) automatic <changed-path\.\.\.>`/)[1];
    const runGeneratedCommand = () => {
      const result = spawnSync("/bin/sh", ["-c", `${command} automatic src/changed.js`], {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, VERIFIER_PATH: "expanded-variable" },
      });
      return { exitCode: result.status, results: JSON.parse(result.stdout) };
    };

    const failure = runGeneratedCommand();
    await writeFile(join(projectDir, "src", "changed.js"), "export {};\n");
    const repaired = runGeneratedCommand();

    // Assert
    assert.deepEqual(failure, {
      exitCode: 1,
      results: [{
        id: "publisher:fail",
        status: "FAIL",
        summary: "Fixture failed",
        evidence: "src/changed.js contains BROKEN",
        nextCheck: "remove BROKEN",
        matches: [{ path: "src/changed.js", trigger: "src/**" }],
      }],
    });
    assert.deepEqual(repaired, {
      exitCode: 0,
      results: [{
        id: "publisher:fail",
        status: "PASS",
        summary: "Fixture repaired",
        evidence: "src/changed.js has no BROKEN marker",
        matches: [{ path: "src/changed.js", trigger: "src/**" }],
      }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
