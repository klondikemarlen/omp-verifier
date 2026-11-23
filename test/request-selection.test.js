import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createRequestIntent } from "#root/omp-plugin/request-intent.js";

const REPOSITORY_ROOT = process.cwd();
const CLI = join(REPOSITORY_ROOT, "bin/omp-verifier.js");

async function fixture(t, { installProjectLint = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "verifier-request-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const plugins = join(root, "plugins");
  const provider = join(plugins, "node_modules", "publisher");
  await mkdir(project);
  await mkdir(provider, { recursive: true });
  const dependencies = {
    publisher: "1.0.0",
  };
  if (installProjectLint) {
    dependencies["omp-verifier"] = "*";
    await symlink(REPOSITORY_ROOT, join(plugins, "node_modules", "omp-verifier"), "dir");
  }

  await writeFile(join(plugins, "package.json"), JSON.stringify({
    name: "omp-plugins",
    dependencies,
  }));
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher",
    omp: { extensions: ["./index.js"], verifications: [
      { id: "publisher:optional", label: "Optional", description: "Optional source check", pathTriggers: ["**/*.js"], entry: "./optional.mjs" },
      { id: "publisher:required", label: "Required", description: "Required source check", entry: "./required.mjs" },
    ] },
  }));
  for (const name of ["optional", "required"]) {
    await writeFile(join(provider, `${name}.mjs`), `import { appendFileSync } from 'node:fs';\nappendFileSync('executed.txt', '${name}\\n');\nconsole.log(JSON.stringify({ status: 'FAIL', summary: '${name} violation' }));\n`);
  }
  await writeFile(join(project, "source.js"), "export const value = 1;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: project });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    encoding: "utf8",
  });
  const sessionId = randomUUID();
  const intent = async prompt => {
    const result = await createRequestIntent({ sessionId, prompt });
    t.after(() => rm(dirname(result.path), { recursive: true, force: true }));
    return result;
  };
  return {
    project,
    provider,
    run,
    intent,
  };
}

test("when a quick request selects changed source, optional checks do not run but project requirements do", async t => {
  // Arrange
  const f = await fixture(t);
  await writeFile(join(f.project, ".omp-verifier.json"), JSON.stringify({ requirements: [
    { id: "publisher:required", path: "**/*.js" },
    { id: "publisher:missing", path: "**/*.js" },
  ] }));
  const intent = await f.intent("Verifier work level: quick tweak\nRename a local binding.");

  // Act
  const result = f.run("automatic", "source.js", "--request", intent.handle);

  // Assert
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    {
      id: "publisher:missing",
      status: "BLOCKED",
      summary: "Required verification provider is not installed",
      evidence: "Declared requirement applies to source.js; no installed manifest provides publisher:missing.",
      matches: [{ path: "source.js", trigger: "**/*.js" }],
    },
    {
      id: "publisher:required",
      status: "FAIL",
      summary: "required violation",
      matches: [{ path: "source.js", trigger: "**/*.js" }],
      scope: {
        mode: "changed-files",
        attribution: "provider-owned",
        repositoryRoot: f.project,
        changedPaths: ["source.js"],
      },
    },
  ]);
  assert.equal(await readFile(join(f.project, "executed.txt"), "utf8"), "required\n");
});

test("when a full request omits its scope, only stderr explains how to verify the PR", async t => {
  // Arrange
  const { run, intent } = await fixture(t);
  const request = await intent("Review the delivery.");

  // Act
  const full = run("automatic", "--request", request.handle, "--full");
  const background = run("automatic", "--request", request.handle);
  const unmatched = run("automatic", "notes.txt", "--request", request.handle, "--full");

  // Assert
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(JSON.parse(full.stdout), []);
  assert.match(full.stderr, /no verdict/i);
  assert.match(full.stderr, /--base <ref> <changed-path\.\.\.>/);
  for (const quiet of [background, unmatched]) {
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.deepEqual(JSON.parse(quiet.stdout), []);
    assert.equal(quiet.stderr, "");
  }
});

test("when a quick request has no requirements, skipping optional checks is an empty result rather than PASS", async t => {
  // Arrange
  const f = await fixture(t);
  const intent = await f.intent("Verifier work level: quick tweak\nRename a local binding.");

  // Act
  const result = f.run("automatic", "source.js", "--request", intent.handle);

  // Assert
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  await assert.rejects(readFile(join(f.project, "executed.txt")), { code: "ENOENT" });
});

for (const mode of ["escalated", "manual", "default", "rearchitecture"]) {
  test(`when ${mode} verification follows a quick request, optional source checks remain effective`, async t => {
    // Arrange
    const f = await fixture(t);
    let intent = await f.intent("Verifier work level: quick tweak\nRename a serialized field.");
    let args = ["automatic", "source.js", "--request", intent.handle, "--full"];
    if (mode === "manual") args = ["verify", "publisher:optional"];
    if (mode === "default") args = ["automatic", "source.js"];
    if (mode === "rearchitecture") {
      intent = await f.intent("Verifier work level: rearchitecture\nChange transaction ownership.");
      args = ["automatic", "source.js", "--request", intent.handle];
    }

    // Act
    const result = f.run(...args);

    // Assert
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].id, "publisher:optional");
    assert.equal(JSON.parse(result.stdout)[0].status, "FAIL");
    assert.equal(await readFile(join(f.project, "executed.txt"), "utf8"), "optional\n");
  });
}

test("when a new request supersedes quick intent, its stale handle cannot exempt the new work", async t => {
  // Arrange
  const f = await fixture(t);
  const previous = await f.intent("Verifier work level: quick tweak\nRename local value.");
  const current = await f.intent("Change authorization to require membership.");

  // Act
  const stale = f.run("automatic", "source.js", "--request", previous.handle);
  const normal = f.run("automatic", "source.js", "--request", current.handle);

  // Assert
  assert.equal(stale.status, 1, stale.stderr);
  assert.equal(JSON.parse(stale.stdout)[0].id, "verifier:request-intent");
  assert.equal(JSON.parse(stale.stdout)[0].status, "BLOCKED");
  assert.equal(normal.status, 1, normal.stderr);
  assert.equal(JSON.parse(normal.stdout)[0].id, "publisher:optional");
  assert.equal(await readFile(join(f.project, "executed.txt"), "utf8"), "optional\n");
});

test("when full verification uses a larger lint budget, it reruns lint alongside other selected checks", async t => {
  // Arrange
  const { project, provider, run, intent } = await fixture(t, {
    installProjectLint: true,
  });
  const request = await intent("Verifier work level: quick tweak\nRename a local binding.");
  const eslint = join(REPOSITORY_ROOT, "node_modules", ".bin", "eslint");
  await writeFile(join(project, ".omp-verifier.json"), JSON.stringify({
    lint: {
      commands: {
        javascript: {
          tool: "eslint",
          command: [process.execPath, "lint-wrapper.mjs", eslint, "--no-fix", "--"],
          appendPaths: true,
        },
      },
    },
  }));
  await writeFile(join(project, "eslint.config.mjs"), `
export default [{
  rules: {
    "no-unused-vars": "error",
  },
}];
`);
  await writeFile(join(project, "unselected.js"), "const unused = true;\n");
  await writeFile(join(project, "lint-wrapper.mjs"), `
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const [command, ...args] = process.argv.slice(2);
await setTimeout(250);
const result = spawnSync(command, args, {
  stdio: "inherit",
});
if (result.status === 0) {
  appendFileSync("lint-completed.txt", args.at(-1) + "\\n");
}
process.exitCode = result.status ?? 2;
`);
  await writeFile(join(provider, "optional.mjs"), `
import { appendFileSync } from "node:fs";

appendFileSync("executed.txt", "optional\\n");
console.log(JSON.stringify({
  status: "PASS",
  summary: "Independent source check completed",
}));
`);
  const args = ["automatic", "source.js", "--request", request.handle, "--full"];

  // Act
  const constrained = run(...args, "--lint-budget-ms", "1");
  const recovered = run(...args, "--lint-budget-ms", "10000");
  const defaultBudget = run(...args);

  // Assert
  assert.equal(constrained.status, 1, constrained.stderr);
  const constrainedChecks = JSON.parse(constrained.stdout);
  assert.equal(constrainedChecks.length, 2);
  assert.equal(constrainedChecks.find(check => check.id === "publisher:optional")?.status, "PASS");
  const blockedLint = constrainedChecks.find(check => check.id === "verifier:project-lint");
  assert.equal(blockedLint?.status, "BLOCKED");
  assert.match(blockedLint.evidence, /\b1\s*ms\b/i);

  for (const result of [recovered, defaultBudget]) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const checks = JSON.parse(result.stdout);
    assert.equal(checks.length, 2);
    assert.equal(checks.find(check => check.id === "publisher:optional")?.status, "PASS");
    assert.equal(checks.find(check => check.id === "verifier:project-lint")?.status, "PASS");
  }
  assert.equal(await readFile(join(project, "lint-completed.txt"), "utf8"), "source.js\nsource.js\n");
  assert.equal(await readFile(join(project, "executed.txt"), "utf8"), "optional\noptional\noptional\n");
});

test("when the automatic lint budget is out of range or lacks --full, no checks run", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t);
  const request = await intent("Review the delivery.");
  const args = ["automatic", "source.js", "--request", request.handle];

  // Act
  const missingFull = run(...args, "--lint-budget-ms", "10000");
  const belowRange = run(...args, "--full", "--lint-budget-ms", "0");
  const aboveRange = run(...args, "--full", "--lint-budget-ms", "600001");

  // Assert
  for (const result of [missingFull, belowRange, aboveRange]) {
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--lint-budget-ms/);
  }
  await assert.rejects(readFile(join(project, "executed.txt")), {
    code: "ENOENT",
  });
});
