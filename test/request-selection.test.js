import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createRequestIntent, openRequestWaiverAuthority } from "#root/omp-plugin/request-intent.js";

const REPOSITORY_ROOT = process.cwd();
const CLI = join(REPOSITORY_ROOT, "bin/omp-verifier.js");

async function fixture(t, { optionalExecutionScope, requiredExecutionScope } = {}) {
  const root = await mkdtemp(join(tmpdir(), "verifier-request-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const plugins = join(root, "plugins");
  const provider = join(plugins, "node_modules", "publisher");
  await mkdir(project);
  await mkdir(provider, { recursive: true });
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher",
    omp: { extensions: ["./index.js"], verifications: [
      {
        id: "publisher:optional",
        label: "Optional",
        description: "Optional source check",
        pathTriggers: ["**/*.js"],
        entry: "./optional.mjs",
        executionScope: optionalExecutionScope,
      },
      {
        id: "publisher:required",
        label: "Required",
        description: "Required source check",
        entry: "./required.mjs",
        executionScope: requiredExecutionScope,
      },
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
  const intent = async (prompt, waiver) => {
    let waiverAuthorityId;
    if (waiver) {
      const authority = await openRequestWaiverAuthority();
      t.after(authority.close);
      waiverAuthorityId = authority.id;
    }

    const result = await createRequestIntent({
      sessionId,
      prompt,
      waiver,
      waiverAuthorityId,
    });
    t.after(() => rm(dirname(result.path), {
      recursive: true,
      force: true,
    }));
    return result;
  };
  return {
    project,
    plugins,
    provider,
    run,
    intent,
  };
}

function commitSources(cwd, message, paths = ["source.js"]) {
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Provider scope fixture",
    "-c", "user.email=provider-scope@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd, encoding: "utf8" }).trim();
  git("add", ...paths);
  git("commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
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

test("when PR verification selects broader executables, neither ordinary nor full execution launches them", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t, {
    optionalExecutionScope: "changed-files",
    requiredExecutionScope: "whole-project",
  });
  const base = commitSources(project, "Baseline");
  await writeFile(join(project, "source.js"), "export const value = 2;\n");
  await writeFile(join(project, "unrequired.js"), "export const other = true;\n");
  commitSources(project, "PR change", ["source.js", "unrequired.js"]);

  const requirements = [
    { id: "publisher:optional", path: "source.js" },
    { id: "publisher:required", path: "source.js" },
  ];
  const policyPath = join(project, ".omp-verifier.json");
  await writeFile(policyPath, JSON.stringify({ requirements }));
  const request = await intent("Review the delivery.");
  const scope = ["automatic", "--base", base, "source.js", "--request", request.handle];

  // Act / Assert
  for (const result of [run(...scope), run(...scope, "--full")]) {
    assert.equal(result.status, 1, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.equal(results.length, 3);
    const [optional, optionalRequiredPath, required] = results;
    assert.deepEqual([optional.id, optional.status], ["publisher:optional", "SUPPRESSED"]);
    assert.match(optional.evidence, /executionScope: "changed-lines"; .*"changed-files"/);
    assert.deepEqual(optional.matches, [{ path: "unrequired.js", trigger: "**/*.js" }]);
    assert.deepEqual([optionalRequiredPath.id, optionalRequiredPath.status], ["publisher:optional", "BLOCKED"]);
    assert.match(optionalRequiredPath.evidence, /executionScope: "changed-lines"; .*"changed-files"/);
    assert.deepEqual(optionalRequiredPath.matches, [{ path: "source.js", trigger: "**/*.js" }]);
    assert.deepEqual([required.id, required.status], ["publisher:required", "BLOCKED"]);
    assert.match(required.evidence, /executionScope: "changed-lines"; .*"whole-project"/);
    assert.deepEqual(required.matches, [{ path: "source.js", trigger: "source.js" }]);
  }

  // A real project suppression takes precedence over the incompatible-scope blocker.
  await writeFile(policyPath, JSON.stringify({
    requirements,
    suppressions: requirements.map(requirement => ({
      ...requirement,
      reason: "The retained project policy exempts this migration.",
    })),
  }));
  const suppressed = run(...scope);
  assert.equal(suppressed.status, 0, suppressed.stderr);
  const [exemptOptional, skipped, exemptRequired] = JSON.parse(suppressed.stdout);
  assert.equal(skipped.status, "SUPPRESSED");
  for (const exempt of [exemptOptional, exemptRequired]) {
    assert.equal(exempt.status, "SUPPRESSED");
    assert.match(exempt.evidence, /The retained project policy exempts this migration/);
  }
  await assert.rejects(readFile(join(project, "executed.txt")), { code: "ENOENT" });
});

test("when a user waives an opaque required PR check, it is waived without execution", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t);
  const base = commitSources(project, "Baseline");
  await writeFile(join(project, "source.js"), "export const value = 2;\n");
  commitSources(project, "PR change");
  await writeFile(join(project, ".omp-verifier.json"), JSON.stringify({
    requirements: [{ id: "publisher:required", path: "source.js" }],
  }));
  const request = await intent("/verifier waive publisher:required", "publisher:required");

  // Act
  const result = run("automatic", "--base", base, "source.js", "--request", request.handle, "--full");

  // Assert
  assert.equal(result.status, 0, result.stderr);
  const [, required] = JSON.parse(result.stdout);
  assert.deepEqual([required.id, required.status], ["publisher:required", "WAIVED"]);
  await assert.rejects(readFile(join(project, "executed.txt")), { code: "ENOENT" });
});

test("when host-bound PR review is given draft paths, only committed delivery files can be reviewed", async t => {
  // Arrange
  const { project, provider, run, intent } = await fixture(t, { optionalExecutionScope: "changed-lines" });
  const trackedPath = join(project, "tracked.js");
  await writeFile(trackedPath, "export const unchanged = true;\n");
  const base = commitSources(project, "Baseline", ["source.js", "tracked.js"]);
  await writeFile(join(project, "source.js"), "export const value = 2;\n");
  const head = commitSources(project, "PR change");
  await writeFile(trackedPath, "export const unsaved = true;\n");
  await writeFile(join(project, "untracked.js"), "export const draft = true;\n");
  await writeFile(join(provider, "optional.mjs"), `
const { wholeFilePaths } = JSON.parse(process.env.OMP_VERIFIER_PR_SCOPE);
const changedPaths = JSON.parse(process.env.OMP_VERIFIER_CHANGED_PATHS);
console.log(JSON.stringify({
  status: "PASS",
  summary: "Inspected selected source paths.",
  evidence: JSON.stringify({ changedPaths, wholeFilePaths }),
}));
`);
  const request = await intent("Review the committed delivery.");
  const delivery = ["automatic", "--base", base];
  const hostScope = [...delivery, "source.js", "tracked.js", "untracked.js", "--request", request.handle];

  // Act
  const hostReview = run(...hostScope);
  const cleanup = run(...hostScope, "--whole-file", "source.js");
  await writeFile(join(project, "source.js"), "export const value = 3;\n");
  const dirtyDelivery = run(...hostScope);

  // Assert
  assert.equal(hostReview.status, 0, hostReview.stderr);
  const [reviewed] = JSON.parse(hostReview.stdout);
  assert.equal(reviewed.status, "PASS");
  assert.equal(reviewed.scope.headCommit, head);
  assert.deepEqual(JSON.parse(reviewed.evidence), { changedPaths: ["source.js"], wholeFilePaths: [] });

  assert.equal(cleanup.status, 2);
  assert.match(cleanup.stderr, /explicit manual cleanup/);


  assert.equal(dirtyDelivery.status, 1, dirtyDelivery.stderr);
  const [overlayBlocker] = JSON.parse(dirtyDelivery.stdout);
  assert.equal(overlayBlocker.status, "BLOCKED");
  assert.match(overlayBlocker.evidence, /working source differs from committed delivery at source\.js/);
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
  await f.intent("Review the intermediate edit.");
  const current = await f.intent("Change authorization to require membership.");

  // Act
  const stale = f.run("automatic", "source.js", "--request", previous.handle);
  const normal = f.run("automatic", "source.js", "--request", current.handle);

  // Assert
  assert.equal(stale.status, 0, stale.stderr);
  const [historical] = JSON.parse(stale.stdout);
  assert.equal(historical.status, "SUPERSEDED");
  assert.equal(normal.status, 1, normal.stderr);
  assert.equal(JSON.parse(normal.stdout)[0].id, "publisher:optional");
  assert.equal(await readFile(join(f.project, "executed.txt"), "utf8"), "optional\n");
});

test("when the active record is missing, even a historical handle cannot hide the blocker", async t => {
  // Arrange
  const f = await fixture(t);
  const previous = await f.intent("Review the first edit.");
  const current = await f.intent("Review the second edit.");
  await rm(current.path);

  // Act
  const stale = f.run("automatic", "source.js", "--request", previous.handle);
  const active = f.run("automatic", "source.js", "--request", current.handle);

  // Assert
  for (const result of [stale, active]) {
    assert.equal(result.status, 1, result.stderr);
    const [blocker] = JSON.parse(result.stdout);
    assert.equal(blocker.status, "BLOCKED");
    assert.match(blocker.nextCheck, /--request <current-handle> --full --base/);
  }
  await assert.rejects(readFile(join(f.project, "executed.txt")), {
    code: "ENOENT",
  });
});

test("when full verification uses a larger lint budget, it reruns lint alongside other selected checks", async t => {
  // Arrange
  const { project, plugins, provider, run, intent } = await fixture(t);
  await symlink(REPOSITORY_ROOT, join(plugins, "node_modules", "omp-verifier"), "dir");
  await writeFile(join(plugins, "package.json"), JSON.stringify({
    name: "omp-plugins",
    dependencies: {
      publisher: "1.0.0",
      "omp-verifier": "*",
    },
  }));
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
  const constrained = run(...args, "--lint-budget-ms", "1", "--progress");
  const recovered = run(...args, "--lint-budget-ms", "10000", "--progress");
  const defaultBudget = run(...args);

  // Assert
  assert.equal(constrained.status, 1, constrained.stderr);
  const constrainedChecks = JSON.parse(constrained.stdout);
  assert.equal(constrainedChecks.length, 2);
  assert.equal(constrainedChecks.find(check => check.id === "publisher:optional")?.status, "PASS");
  const blockedLint = constrainedChecks.find(check => check.id === "verifier:project-lint");
  assert.equal(blockedLint?.status, "BLOCKED");
  assert.match(blockedLint.summary, /Shared project lint budget of 1 ms expired; Never started: javascript \(\.\)/);
  assert.match(blockedLint.nextCheck, /For `automatic --full`, retry the same request and scope.*--lint-budget-ms/);
  assert.match(blockedLint.evidence, /\b1\s*ms\b/i);
  assert.match(blockedLint.lintVerdicts, /BLOCKED — lint did not complete · javascript \(\.\)/);
  assert.match(blockedLint.lintVerdicts, /Next: retry the same scope with a larger lint budget/);

  assert.match(constrained.stderr, /verifier:project-lint returned BLOCKED/);
  assert.match(recovered.stderr, /verifier:project-lint returned PASS/);
  for (const result of [constrained, recovered]) {
    assert.match(result.stderr, /verifier:project-lint started .*enforced timeout: \d+ ms/);
    assert.match(result.stderr, /coordinator finished/);
  }
  assert.equal(defaultBudget.stderr, "");

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

test("when the current user waives the whole run, full automatic verification does not dispatch any check", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t);
  const request = await intent("/verifier waive verification", "verification");

  // Act
  const result = run("automatic", "source.js", "--request", request.handle, "--full", "--failures-only");

  // Assert
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    {
      id: "verification",
      status: "WAIVED",
      summary: "Verification waived by user; no verdict was produced",
      evidence: `User authorization in request ${request.requestId}.`,
    },
  ]);
  await assert.rejects(readFile(join(project, "executed.txt")), {
    code: "ENOENT",
  });
});

test("when the user waives source verification, a separately requested closeout still runs", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t);
  const request = await intent("/verifier waive verification", "verification");

  // Act
  const result = run("automatic", "source.js", "--closeout", "unavailable.json", "--request", request.handle);

  // Assert
  assert.equal(result.status, 1, result.stderr);
  const outcomes = JSON.parse(result.stdout).map(({ id, status }) => [id, status]);
  assert.deepEqual(outcomes, [
    ["verification", "WAIVED"],
    ["verifier:resource-closeout", "BLOCKED"],
  ]);
  await assert.rejects(readFile(join(project, "executed.txt")), {
    code: "ENOENT",
  });
});

test("when the user waives one automatic check, unwaived project requirements still run", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t);
  await writeFile(join(project, ".omp-verifier.json"), JSON.stringify({
    requirements: [
      {
        id: "publisher:required",
        path: "**/*.js",
      },
    ],
  }));
  const request = await intent("/verifier waive publisher:optional", "publisher:optional");

  // Act
  const result = run("automatic", "source.js", "--request", request.handle, "--full", "--failures-only");

  // Assert
  assert.equal(result.status, 1, result.stderr);
  const outcomes = JSON.parse(result.stdout).map(({ id, status }) => [id, status]);
  assert.deepEqual(outcomes.sort(), [
    ["publisher:optional", "WAIVED"],
    ["publisher:required", "FAIL"],
  ]);
  assert.equal(await readFile(join(project, "executed.txt"), "utf8"), "required\n");
});

test("when the user waives closeout in a combined run, source checks still run", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t);
  const request = await intent("/verifier waive verifier:resource-closeout", "verifier:resource-closeout");

  // Act
  const result = run("automatic", "source.js", "--closeout", "unavailable.json", "--request", request.handle);

  // Assert
  assert.equal(result.status, 1, result.stderr);
  const outcomes = JSON.parse(result.stdout).map(({ id, status }) => [id, status]);
  assert.deepEqual(outcomes, [
    ["publisher:optional", "FAIL"],
    ["verifier:resource-closeout", "WAIVED"],
  ]);
  assert.equal(await readFile(join(project, "executed.txt"), "utf8"), "optional\n");
});

test("when the user waives one manually selected check, other requested checks still run", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t);
  const request = await intent("/verifier waive publisher:optional", "publisher:optional");

  // Act
  const result = run("verify", "publisher:optional", "publisher:required", "--request", request.handle);

  // Assert
  assert.equal(result.status, 1, result.stderr);
  const outcomes = JSON.parse(result.stdout).map(({ id, status }) => [id, status]);
  assert.deepEqual(outcomes, [
    ["publisher:optional", "WAIVED"],
    ["publisher:required", "FAIL"],
  ]);
  assert.equal(await readFile(join(project, "executed.txt"), "utf8"), "required\n");
});

test("when another prompt supersedes a one-prompt waiver, its old handle cannot waive the current work", async t => {
  // Arrange
  const { project, run, intent } = await fixture(t);
  const previous = await intent("/verifier waive publisher:optional", "publisher:optional");
  const current = await intent("Review an unrelated edit.");

  // Act
  const historical = run("verify", "publisher:optional", "--request", previous.handle);
  const active = run("verify", "publisher:optional", "--request", current.handle);

  // Assert
  assert.equal(historical.status, 0, historical.stderr);
  assert.equal(JSON.parse(historical.stdout)[0].status, "SUPERSEDED");
  assert.equal(active.status, 1, active.stderr);
  assert.equal(JSON.parse(active.stdout)[0].status, "FAIL");
  assert.equal(await readFile(join(project, "executed.txt"), "utf8"), "optional\n");
});

test("when an agent passes a waiver flag, the CLI rejects the grant instead of dispatching", async t => {
  // Arrange
  const { project, run } = await fixture(t);

  // Act
  const result = run("verify", "publisher:optional", "--waive", "publisher:optional");

  // Assert
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option '--waive'/);
  await assert.rejects(readFile(join(project, "executed.txt")), {
    code: "ENOENT",
  });
});
