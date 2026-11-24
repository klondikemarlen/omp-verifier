import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const ESLINT = fileURLToPath(new URL("../node_modules/eslint/bin/eslint.js", import.meta.url));
const COMMAND_TIMEOUT_MS = 20_000;
const SOURCE = "export const limit = 2;\n";

function killProcessGroup(pid) {
  if (!pid) return;

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitUntil(predicate, signal) {
  while (!await predicate()) {
    await delay(20, undefined, {
      signal,
    });
  }
}

async function restartProject(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-restart-"));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
  }));
  const cwd = join(root, "checkout");
  const plugins = join(root, "plugins");
  const packageDirectory = join(plugins, "node_modules");
  const provider = join(packageDirectory, "publisher");
  const invocationLog = join(root, "invocations.log");
  const releasePath = join(root, "release");
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    PI_CODING_AGENT_DIR: join(root, "agent"),
    OMP_VERIFIER_PACKAGE_DIRECTORY: packageDirectory,
  };
  await mkdir(cwd);
  await mkdir(provider, {
    recursive: true,
  });
  await writeFile(invocationLog, "");
  await writeFile(join(plugins, "package.json"), JSON.stringify({
    name: "omp-plugins",
    dependencies: {
      publisher: "1.0.0",
    },
  }));
  await writeFile(join(cwd, "source.js"), "export const limit = 1;\n");
  const gitOptions = {
    cwd,
    env,
    timeout: COMMAND_TIMEOUT_MS,
  };
  execFileSync("git", ["init", "--quiet"], gitOptions);
  execFileSync("git", ["add", "source.js"], gitOptions);
  execFileSync("git", ["-c", "user.name=Verifier Test", "-c", "user.email=verifier@example.com", "commit", "--quiet", "-m", "Initial source"], gitOptions);
  await writeFile(join(cwd, "source.js"), SOURCE);
  await writeFile(join(cwd, "notes.js"), "export const note = 'before';\n");

  // Only the execution controls change between identical invocations, not their environment or project inputs.
  const recordInvocation = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

async function recordInvocation(unit, gatedUnit) {
  appendFileSync(${JSON.stringify(invocationLog)}, unit + "\\n");
  if (unit === gatedUnit) {
    const signal = AbortSignal.timeout(30_000);
    while (!existsSync(${JSON.stringify(releasePath)})) {
      await delay(20, undefined, {
        signal,
      });
    }
  }
}
`;

  async function installChecks(verifications) {
    await writeFile(join(provider, "index.mjs"), "export {};\n");
    await writeFile(join(provider, "package.json"), JSON.stringify({
      name: "publisher",
      version: "1.0.0",
      omp: {
        extensions: ["./index.mjs"],
        verifications,
      },
    }));
    await writeFile(join(provider, "completed.mjs"), `${recordInvocation}
await recordInvocation("completed");
const notes = readFileSync("notes.js", "utf8").trim();
console.log(JSON.stringify({
  status: "PASS",
  summary: "Completed source check",
  evidence: notes,
}));
`);
    await writeFile(join(provider, "interrupted.mjs"), `${recordInvocation}
await recordInvocation("interrupted", "interrupted");
console.log(JSON.stringify({
  status: "PASS",
  summary: "Interrupted check completed",
  evidence: "Passed after the external gate opened.",
}));
`);
  }

  async function invocations() {
    const log = await readFile(invocationLog, "utf8");
    return log.split("\n").filter(Boolean);
  }

  async function release() {
    await writeFile(releasePath, "");
  }

  function runJson(args) {
    const result = spawnSync(process.execPath, [CLI, ...args, "--reporter", "json"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }

  async function cancelAt(args, unit, completedCheckId) {
    const child = spawn(process.execPath, [CLI, ...args, "--reporter", "json"], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", chunk => {
      stderr += chunk;
    });
    const deadline = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
    const completion = once(child, "close", {
      signal: deadline,
    });
    const readiness = new AbortController();
    const readinessSignal = AbortSignal.any([deadline, readiness.signal]);
    async function readyToCancel() {
      if (!(await invocations()).includes(unit)) {
        return false;
      }

      if (!completedCheckId) {
        return true;
      }

      // Manual checks can start concurrently. Use the coordinator observation only as a readiness barrier.
      const [run] = runJson(["timings"]);
      return run?.checks.some(check => check.id === completedCheckId && check.status === "PASS");
    }

    try {
      await Promise.race([
        waitUntil(readyToCancel, readinessSignal),
        completion.then(([code, signal]) => {
          assert.fail(`Verification exited before it could be cancelled during ${unit} (${code ?? signal}): ${stderr || stdout}`);
        }),
      ]);
      assert.ok(child.kill("SIGTERM"));
      assert.deepEqual(await completion, [null, "SIGTERM"], stderr);
      assert.equal(stdout, "", "Cancellation must not print a verdict");
    } finally {
      readiness.abort();
      killProcessGroup(child.pid);
    }
  }

  return {
    root,
    cwd,
    provider,
    recordInvocation,
    installChecks,
    invocations,
    release,
    runJson,
    cancelAt,
  };
}

function executableCheck(unit) {
  return {
    id: `publisher:${unit}`,
    label: `${unit} source check`,
    description: "Produces evidence for the selected source.",
    entry: `./${unit}.mjs`,
    pathTriggers: ["*.js"],
    timeoutMs: 40_000,
  };
}

async function semanticCheck(provider) {
  await writeFile(join(provider, "standard.md"), "The exported limit is positive.\n");
  await writeFile(join(provider, "limit.json"), JSON.stringify({
    version: 1,
    standardId: "publisher:limit",
    source: "./standard.md",
    gold: "The exported limit is positive.",
    requiredContext: ["changed-code"],
    rubric: [{
      id: "positive",
      question: "Is the exported limit positive?",
    }],
  }));
  return {
    id: "publisher:limit",
    label: "Positive exported limit",
    description: "Prepares the current source for a semantic assessment.",
    mode: "agentic",
    contract: "./limit.json",
    pathTriggers: ["source.js"],
  };
}

test("when automatic verification is cancelled, the same command resumes completed checks and preserves semantic review", async t => {
  // Arrange
  const project = await restartProject(t);
  const review = await semanticCheck(project.provider);
  await project.installChecks([executableCheck("completed"), review, executableCheck("interrupted")]);
  const args = ["automatic", "source.js"];

  // Act
  await project.cancelAt(args, "interrupted");
  assert.deepEqual(await project.invocations(), ["completed", "interrupted"]);
  const [cancelled] = project.runJson(["timings"]);
  const prepared = cancelled.checks.find(check => check.id === review.id);
  assert.equal(prepared.status, "PENDING");
  await project.release();
  const resumed = project.runJson(args);

  // Assert
  assert.deepEqual(await project.invocations(), ["completed", "interrupted", "interrupted"]);
  assert.deepEqual(resumed.map(({ id, status }) => [id, status]), [
    ["publisher:completed", "PASS"],
    ["publisher:limit", "PENDING"],
    ["publisher:interrupted", "PASS"],
  ]);
  const [completed, pending, interrupted] = resumed;
  assert.equal(completed.evidence, "export const note = 'before';");
  assert.equal(interrupted.evidence, "Passed after the external gate opened.");
  assert.equal(pending.reviewRequest.requestId, prepared.requestId);
  assert.deepEqual(pending.reviewRequest.scope.changedPaths, ["source.js"]);
  assert.equal(pending.reviewRequest.context.changedCode.find(source => source.path === "source.js")?.content, SOURCE);

  const [reviewable] = project.runJson(["review", pending.reviewRequest.path]);
  assert.equal(reviewable.status, "PENDING");
  assert.equal(reviewable.reviewRequest.requestId, pending.reviewRequest.requestId);
  const reviewedSource = reviewable.reviewRequest.context.changedCode.find(source => source.path === "source.js");
  assert.equal(reviewedSource?.content[1], SOURCE.trim());

  project.runJson(args);
  assert.deepEqual(await project.invocations(), ["completed", "interrupted", "interrupted", "completed", "interrupted"]);
});

test("when a manual verification is cancelled, an explicit rerun reports both the completed and interrupted checks", async t => {
  // Arrange
  const project = await restartProject(t);
  await project.installChecks([executableCheck("completed"), executableCheck("interrupted")]);
  const args = ["verify", "publisher:completed", "publisher:interrupted"];

  // Act
  await project.cancelAt(args, "interrupted", "publisher:completed");
  assert.deepEqual((await project.invocations()).sort(), ["completed", "interrupted"]);
  await project.release();
  const resumed = project.runJson(args);

  // Assert
  assert.deepEqual((await project.invocations()).sort(), ["completed", "interrupted", "interrupted"]);
  assert.deepEqual(resumed, [
    {
      id: "publisher:completed",
      status: "PASS",
      summary: "Completed source check",
      evidence: "export const note = 'before';",
    },
    {
      id: "publisher:interrupted",
      status: "PASS",
      summary: "Interrupted check completed",
      evidence: "Passed after the external gate opened.",
    },
  ]);
});

test("when untracked source bytes change before a restart, automatic verification discards the interrupted run's evidence", async t => {
  // Arrange
  const project = await restartProject(t);
  await project.installChecks([executableCheck("completed"), executableCheck("interrupted")]);
  const args = ["automatic", "--worktree"];

  // Act
  await project.cancelAt(args, "interrupted");
  assert.deepEqual(await project.invocations(), ["completed", "interrupted"]);
  await writeFile(join(project.cwd, "notes.js"), "export const note = 'second';\n");
  await project.release();
  const restarted = project.runJson(args);

  // Assert
  assert.deepEqual(await project.invocations(), ["completed", "interrupted", "completed", "interrupted"]);
  assert.deepEqual(restarted.map(({ id, status }) => [id, status]), [
    ["publisher:completed", "PASS"],
    ["publisher:interrupted", "PASS"],
  ]);
  assert.equal(restarted[0].evidence, "export const note = 'second';");
});

test("when lint is cancelled during a second project group, the same command reports both real lint outcomes", async t => {
  // Arrange
  const project = await restartProject(t);
  const wrapper = join(project.root, "lint-wrapper.mjs");
  await writeFile(wrapper, `${project.recordInvocation}
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const unit = basename(process.cwd());
await recordInvocation(unit, "second");
const result = spawnSync(process.execPath, process.argv.slice(2), {
  stdio: "inherit",
});
if (result.status === 0) {
  console.log("Verified by ESLint: " + unit + "/" + process.argv.at(-1));
}
process.exitCode = result.status ?? 2;
`);
  for (const unit of ["first", "second"]) {
    const owner = join(project.cwd, unit);
    await mkdir(owner);
    await writeFile(join(owner, "source.js"), SOURCE);
    await writeFile(join(owner, "eslint.config.mjs"), `export default [{
  rules: {
    "no-unused-vars": "error",
  },
}];
`);
    await writeFile(join(owner, ".omp-verifier.json"), JSON.stringify({
      lint: {
        commands: {
          javascript: {
            tool: "eslint",
            command: [process.execPath, wrapper, ESLINT, "--no-fix", "--"],
            appendPaths: true,
          },
        },
      },
    }));
  }
  const args = ["lint", "first/source.js", "second/source.js", "--budget-ms", "30000"];

  // Act
  await project.cancelAt(args, "second");
  assert.deepEqual(await project.invocations(), ["first", "second"]);
  await project.release();
  const [resumed] = project.runJson(args);

  // Assert
  assert.deepEqual(await project.invocations(), ["first", "second", "second"]);
  assert.equal(resumed.id, "verifier:project-lint");
  assert.equal(resumed.status, "PASS");
  assert.equal(resumed.summary, "Lint execution for 2 applicable project/language group(s)");
  assert.match(resumed.evidence, /javascript \(first\): PASS[^\n]*\nVerified by ESLint: first\/source\.js/);
  assert.match(resumed.evidence, /javascript \(second\): PASS[^\n]*\nVerified by ESLint: second\/source\.js/);
});
