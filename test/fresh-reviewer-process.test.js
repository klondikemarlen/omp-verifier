import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runFreshReviewer } from "#root/omp-plugin/fresh-reviewer-process.js";

const SHELL_STUB_OPTIONS = {
  skip: process.platform === "win32",
};
const execFileAsync = promisify(execFile);

async function reviewerDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "omp-fresh-reviewer-"));
  t.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));
  return realpath(directory);
}

function setTestEnvironment(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
  }
}

async function stubReviewer(t, directory, script) {
  await writeFile(join(directory, "omp"), `#!/usr/bin/env node\n${script}`, {
    mode: 0o700,
  });
  setTestEnvironment(t, {
    PATH: `${directory}${delimiter}${process.env.PATH}`,
  });
}

test("when dispatching a saved review, fresh OMP retains routes and approval policies", SHELL_STUB_OPTIONS, async t => {
  // Arrange
  const cwd = await reviewerDirectory(t);
  const coordinator = join(cwd, "coordinator's launcher.mjs");
  const requestPath = join(cwd, 'saved "review"\nrequest.json');
  const reviewTarget = {
    url: "https://github.com/example/consumer/pull/12",
    targetBranch: "release/next",
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
  };
  const parentEnvironment = {
    OMP_BASH_SESSION: "parent-bash",
    OMP_INSTANCE_CONTROL_LAUNCH_TOKEN: "parent-control-token",
    PI_CODING_AGENT_SESSION_DIR: "/parent/session-dir",
    PI_SESSION_FILE: "/parent/session.jsonl",
    PI_SESSION_ID: "parent-session",
    PI_TOOL_CALL_ID: "parent-tool-call",
    OMP_VERIFIER_PR_SCOPE: "unrelated prior scope",
  };
  const inheritedEnvironment = {
    OMP_PROFILE: "work",
    OMP_VERIFIER_GENERATION: '{"id":"current-generation"}',
    OMP_VERIFIER_SEMANTIC_CACHE: join(cwd, "review-cache"),
  };
  setTestEnvironment(t, {
    ...parentEnvironment,
    ...inheritedEnvironment,
  });
  const observedNames = [
    ...Object.keys(parentEnvironment),
    ...Object.keys(inheritedEnvironment),
    "OMP_VERIFIER_COORDINATOR",
    "OMP_VERIFIER_FRESH_REVIEWER",
  ];
  await stubReviewer(t, cwd, `
const { readFileSync, writeFileSync } = require('node:fs');
const env = Object.fromEntries(${JSON.stringify(observedNames)}.map(name => [name, process.env[name] ?? null]));
writeFileSync('observed.json', JSON.stringify({
  cwd: process.cwd(),
  args: process.argv.slice(2),
  prompt: readFileSync(0, 'utf8'),
  env,
}), {
  flag: 'wx',
});
console.log('PASS from ordinary OMP output');
`);

  // Act
  const returned = await runFreshReviewer({
    cwd,
    requestPath,
    coordinator,
    reviewTarget,
  });

  // Assert
  const observed = JSON.parse(await readFile(join(cwd, "observed.json"), "utf8"));
  assert.equal(returned, undefined);
  assert.equal(observed.cwd, cwd);
  assert.deepEqual(observed.args, ["--print", "--advisor", "--no-session", "--tools="]);
  assert.deepEqual(observed.env, {
    ...Object.fromEntries(Object.keys(parentEnvironment).map(name => [name, null])),
    ...inheritedEnvironment,
    OMP_VERIFIER_COORDINATOR: coordinator,
    OMP_VERIFIER_FRESH_REVIEWER: requestPath,
  });
  const handoffLine = observed.prompt.split("\n").find(line => line.startsWith('{"checkout":'));
  assert.deepEqual(JSON.parse(handoffLine), {
    checkout: cwd,
    requestPath,
    coordinator,
    reviewTarget,
  });
});

test("when OMP is missing, the runner reports that it could not launch", SHELL_STUB_OPTIONS, async t => {
  // Arrange
  const cwd = await reviewerDirectory(t);
  setTestEnvironment(t, {
    PATH: cwd,
  });

  // Act
  const review = runFreshReviewer({
    cwd,
    requestPath: join(cwd, "request.json"),
    coordinator: join(cwd, "omp-verifier.mjs"),
    reviewTarget: null,
  });

  // Assert
  await assert.rejects(review, /Could not start fresh named verifier with omp:.*ENOENT/);
});

test("when OMP exits unsuccessfully, printed text is not a result", SHELL_STUB_OPTIONS, async t => {
  // Arrange
  const cwd = await reviewerDirectory(t);
  await stubReviewer(t, cwd, `
require('node:fs').readFileSync(0);
console.log('PASS from ordinary OMP output');
console.error('private reviewer diagnostic');
process.exitCode = 7;
`);

  // Act
  const review = runFreshReviewer({
    cwd,
    requestPath: join(cwd, "request.json"),
    coordinator: join(cwd, "omp-verifier.mjs"),
    reviewTarget: null,
  });

  // Assert
  await assert.rejects(review, /^Error: Fresh named verifier exited with status 7$/);
});

test("when the coordinator receives SIGTERM, the fresh reviewer receives it too", SHELL_STUB_OPTIONS, async t => {
  // Arrange
  const cwd = await reviewerDirectory(t);
  await stubReviewer(t, cwd, `
const { readFileSync, writeFileSync } = require('node:fs');
const waitForSignal = setTimeout(() => {}, 3_000);
process.on('SIGTERM', signal => {
  writeFileSync('received-signal', signal);
  clearTimeout(waitForSignal);
});
readFileSync(0);
process.kill(process.ppid, 'SIGTERM');
`);
  const runnerModule = new URL("../omp-plugin/fresh-reviewer-process.js", import.meta.url).href;
  const configuration = JSON.stringify({
    cwd,
    requestPath: join(cwd, "request.json"),
    coordinator: join(cwd, "omp-verifier.mjs"),
    reviewTarget: null,
  });
  const driver = `
import { runFreshReviewer } from ${JSON.stringify(runnerModule)};
try {
  await runFreshReviewer(${configuration});
} catch (error) {
  console.log(error.message);
}
`;

  // Act
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", driver], {
    timeout: 4_000,
  });

  // Assert
  assert.equal(await readFile(join(cwd, "received-signal"), "utf8"), "SIGTERM");
  assert.equal(stdout.trim(), "Fresh named verifier was cancelled (SIGTERM)");
});
