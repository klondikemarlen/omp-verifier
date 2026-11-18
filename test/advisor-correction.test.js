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
  const agentDir = join(root, "agent 'quoted' $VERIFIER_PATH $(printf expanded)");
  const packageDir = join(root, "plugins", "node_modules", "publisher");
  const projectDir = join(root, "project");
  const checkPath = join(packageDir, "fail.mjs");
  const installedPackage = join(root, "verifier 'quoted' \"double\" $VERIFIER_PATH $(printf expanded) $& $$ $'replacement'");
  const guidancePath = join(agentDir, "verifier", "WATCHDOG.md");
  const previousCliPath = join(root, "previous-coordinator.mjs");

  try {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const entry of ["package.json", ...manifest.files]) {
      await cp(new URL(`../${entry}`, import.meta.url), join(installedPackage, entry), { recursive: true });
    }

    const { default: verifierPlugin } = await import(pathToFileURL(join(installedPackage, "omp-plugin", "index.js")));
    const pi = {
      pi: { getAgentDir() { return agentDir; } },
      setLabel() {},
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
    };

    await mkdir(join(projectDir, "src"), { recursive: true });
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(projectDir, "src", "changed.txt"), "BROKEN\n");
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

const failed = readFileSync("src/changed.txt", "utf8").includes("BROKEN");
process.stdout.write(JSON.stringify(failed
  ? { status: "FAIL", summary: "Fixture failed", evidence: "src/changed.txt contains BROKEN", nextCheck: "remove BROKEN" }
  : { status: "PASS", summary: "Fixture repaired", evidence: "src/changed.txt has no BROKEN marker" }));
process.exitCode = failed ? 1 : 0;
`);
    execFileSync("git", ["init", "--quiet"], { cwd: projectDir });
    await mkdir(join(agentDir, "verifier"), { recursive: true, mode: 0o755 });
    await writeFile(previousCliPath, "process.stdout.write('');\n");
    await writeFile(guidancePath, `Run \`node '${previousCliPath}' automatic <changed-path...> --reporter text --failures-only\`.\n`);

    // Act
    await verifierPlugin(pi);
    const guidance = await readFile(guidancePath, "utf8");
    const [, command, options] = guidance.match(/`(node .+? automatic )<changed-path\.\.\.>(.*?)`/);
    const runGeneratedCommand = () => {
      const result = spawnSync("/bin/sh", ["-c", `${command}src/changed.txt${options}`], {
        cwd: projectDir,
        encoding: "utf8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, VERIFIER_PATH: "expanded-variable" },
      });
      return result;
    };

    const failure = runGeneratedCommand();
    await writeFile(join(projectDir, "src", "changed.txt"), "REPAIRED\n");
    const repaired = runGeneratedCommand();
    const evidence = failure.stdout.includes("src/changed.txt contains BROKEN");

    // Assert
    assert.equal(failure.status, 1);
    assert.equal(evidence, true);
    assert.equal(repaired.status, 0);
    assert.equal(repaired.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
