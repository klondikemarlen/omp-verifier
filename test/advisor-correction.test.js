import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("when startup finds stale guidance in a shell-sensitive install, first-session checks use the installed coordinator", async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-advisor-spec-"));
  const agentDir = join(root, "agent");
  const packageDir = join(root, "plugins", "node_modules", "publisher");
  const projectDir = join(root, "project");
  const checkPath = join(packageDir, "fail.mjs");
  const installedPackage = join(root, "verifier 'quoted' \"double\" $VERIFIER_PATH $(printf expanded) $& $$ $'replacement'");
  const guidancePath = join(agentDir, "verifier", "WATCHDOG.md");
  const previousCliPath = join(root, "previous-coordinator.mjs");

  try {
    for (const entry of ["package.json", "WATCHDOG.md", "bin", "omp-plugin"]) {
      await cp(new URL(`../${entry}`, import.meta.url), join(installedPackage, entry), { recursive: true });
    }

    const { default: verifierPlugin } = await import(pathToFileURL(join(installedPackage, "omp-plugin", "index.js")));
    const pi = {
      pi: { getAgentDir() { return agentDir; } },
      setLabel() {},
      on() {},
      registerCommand() {},
    };

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
    await mkdir(join(agentDir, "verifier"), { recursive: true });
    await writeFile(previousCliPath, "process.stdout.write('');\n");
    await writeFile(guidancePath, `Run \`node '${previousCliPath}' automatic <changed-path...> --reporter text --failures-only\`.\n`);

    // Act
    await verifierPlugin(pi);
    const guidance = await readFile(guidancePath, "utf8");
    const [, command, options] = guidance.match(/`(node .+? automatic )<changed-path\.\.\.>(.*?)`/);
    const runGeneratedCommand = () => {
      const result = spawnSync("/bin/sh", ["-c", `${command}src/changed.js${options}`], {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, VERIFIER_PATH: "expanded-variable" },
      });
      return result;
    };

    const failure = runGeneratedCommand();
    await writeFile(join(projectDir, "src", "changed.js"), "export {};\n");
    const repaired = runGeneratedCommand();

    // Assert
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, `FAIL publisher:fail
  Fixture failed
  Evidence: src/changed.js contains BROKEN
  Next check: remove BROKEN
`);
    assert.equal(repaired.status, 0);
    assert.equal(repaired.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
