import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const policySource = "export function positive(value) { if (value <= 0) throw new RangeError(); return value; }\n";

async function semanticCliFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-semantic-cli-"));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
  }));
  const provider = join(root, "plugins", "node_modules", "publisher");
  const cacheDirectory = join(root, "private-cache");
  await mkdir(provider, {
    recursive: true,
  });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "policy.js"), policySource);
  await writeFile(join(root, "src", "first.js"), "export const first = true;\n");
  await writeFile(join(root, "src", "second.js"), "export const second = true;\n");
  await writeFile(join(provider, "standard.md"), "The positive function rejects non-positive inputs.\n");
  const contract = {
    version: 1,
    standardId: "publisher:alignment",
    source: "./standard.md",
    gold: "The positive function rejects non-positive inputs.",
    requiredContext: ["changed-code"],
    rubric: [
      {
        id: "validation",
        question: "Does positive enforce its input invariant?",
      },
    ],
  };
  await writeFile(join(provider, "alignment.json"), JSON.stringify(contract));
  const manifest = {
    name: "publisher",
    version: "1.0.0",
    omp: {
      extensions: ["./index.js"],
      verifications: [
        {
          id: "publisher:alignment",
          label: "Positive Validation",
          description: "Assesses the validation invariant.",
          mode: "agentic",
          contract: "./alignment.json",
          pathTriggers: ["src/*.js"],
        },
      ],
    },
  };
  await writeFile(join(provider, "package.json"), JSON.stringify(manifest));
  const gitOptions = {
    cwd: root,
  };
  execFileSync("git", ["init", "--quiet"], gitOptions);
  execFileSync("git", ["add", "."], gitOptions);
  execFileSync("git", ["-c", "user.name=Verifier Tests", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "baseline"], gitOptions);
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: join(root, "agent"),
    OMP_VERIFIER_SEMANTIC_CACHE: cacheDirectory,
  };
  function run(args, input) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      env,
      input,
    });
  }
  const prepared = run(["automatic", "src/policy.js"]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const result = JSON.parse(prepared.stdout)[0];
  assert.equal(result.status, "PENDING");
  return {
    root,
    cacheDirectory,
    request: result.reviewRequest,
    run,
  };
}

async function cacheSnapshot(directory) {
  const paths = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const snapshot = {};
  for (const entry of paths) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    snapshot[path] = await readFile(path, "utf8");
  }
  return snapshot;
}

test("when review inputs conflict or flags are irrelevant, request state does not advance", async t => {
  // Arrange
  const fixture = await semanticCliFixture(t);
  const before = await cacheSnapshot(fixture.cacheDirectory);
  const requestPath = fixture.request.path;
  const reviewArguments = [
    ["--page", "0"],
    ["--continue", "--batch", "0"],
    ["--continue", "--page", "1", "--reporter", "text"],
    ["--page", "-1", "--reporter", "text"],
    ["--batch", "1.5"],
    ["--max-context-paths", "29"],
    ["--max-context-paths", "257"],
  ];
  for (const flag of ["--context", "--caller-context", "--external-context", "--remove-context"]) {
    reviewArguments.push(["--page", "1", "--reporter", "text", flag, "src/first.js"]);
  }
  reviewArguments.push(["--page", "1", "--reporter", "text", "--max-context-paths", "30"]);
  const rejectedCommands = reviewArguments.map(args => ["review", requestPath, ...args]);
  rejectedCommands.push(
    ["evaluate", requestPath, "--assessment", "-", "--context", "src/first.js"],
    ["evaluate", requestPath, "--assessment", "-", "--continue"],
    ["diagnostics", requestPath, "--batch", "0"],
  );

  // Act / Assert
  for (const args of rejectedCommands) {
    const rejected = fixture.run(args, "not assessment JSON");
    assert.equal(rejected.status, 2, `${args.join(" ")}\n${rejected.stderr}`);
    assert.equal(rejected.stdout, "");
    assert.notEqual(rejected.stderr, "");
    const after = await cacheSnapshot(fixture.cacheDirectory);
    assert.deepEqual(after, before);
  }
});

test("when context options repeat, both selectors and citation coordinates survive review", async t => {
  // Arrange
  const fixture = await semanticCliFixture(t);
  const selectors = ["src/first.js", "src/second.js"];

  // Act
  const reviewed = fixture.run([
    "review", fixture.request.path,
    "--context", selectors[0],
    "--context", selectors[1],
  ]);

  // Assert
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const result = JSON.parse(reviewed.stdout)[0];
  assert.deepEqual(result.reviewRequest.scope.contextPaths, selectors);
  assert.notEqual(result.reviewRequest.requestId, fixture.request.requestId);
  const changedCode = result.reviewRequest.context.changedCode.find(record => record.path === "src/policy.js");
  assert.equal(changedCode.content[1], policySource.trim());
});

test("when an assessment arrives on stdin, completion retains JSON and failure-only text behavior", async t => {
  // Arrange
  const fixture = await semanticCliFixture(t);
  const quote = policySource.trim();
  const assessment = {
    requestId: fixture.request.requestId,
    status: "PASS",
    summary: "The positive function rejects non-positive inputs.",
    rationale: "The value <= 0 guard throws before returning the input.",
    citations: [
      {
        path: "src/policy.js",
        line: 1,
        quote,
      },
    ],
  };
  const assessmentInput = JSON.stringify(assessment);

  // Act
  const completed = fixture.run(["evaluate", fixture.request.path, "--assessment", "-"], assessmentInput);
  const replay = fixture.run([
    "evaluate", fixture.request.path, "--assessment", "-", "--reporter", "text", "--failures-only",
  ], assessmentInput);

  // Assert
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout)[0].status, "PASS");
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(replay.stdout, "");
});

test("when diagnostics cannot read a request, private paths and source-bearing errors remain hidden", async t => {
  // Arrange
  const fixture = await semanticCliFixture(t);
  const privatePath = join(fixture.root, "private-customer-source-secret.json");
  await writeFile(privatePath, "PRIVATE_SOURCE_CONTENT not JSON");

  // Act / Assert
  for (const reporter of ["json", "text"]) {
    const diagnostics = fixture.run(["diagnostics", privatePath, "--reporter", reporter]);
    assert.equal(diagnostics.status, 1);
    assert.equal(diagnostics.stderr, "");
    assert.deepEqual(JSON.parse(diagnostics.stdout), {
      status: "BLOCKED",
      reason: "diagnostics-unavailable",
    });
    assert.ok(!diagnostics.stdout.includes(fixture.root));
    assert.ok(!diagnostics.stdout.includes("PRIVATE_SOURCE_CONTENT"));
  }
});
