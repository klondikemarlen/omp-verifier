import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));

async function reporterFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-reporters-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = join(root, "plugins", "node_modules", "publisher");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(root, "plugins", "package.json"), JSON.stringify({
    name: "omp-plugins",
    dependencies: { publisher: "1.0.0" },
  }));
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
    name: "publisher",
    omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: "publisher:alignment",
        label: "Alignment",
        description: "Check ordered comments",
        entry: "./alignment.mjs",
        pathTriggers: ["**/*.test.ts"],
      }, {
        id: "publisher:pass",
        label: "Passing check",
        description: "Already meets Gold",
        entry: "./pass.mjs",
        pathTriggers: ["**/*.test.ts"],
      }],
    },
  }));
  await writeFile(join(packageDirectory, "alignment.mjs"), `
process.stdout.write(JSON.stringify({
  status: "FAIL",
  summary: "1 test-alignment violation found.",
  evidence: "tests/downloads.test.ts:169: missing ordered comments\\nExpected Arrange, Act, Assert.",
  nextCheck: "Add ordered comments.",
}));
process.exitCode = 1;
`);
  await writeFile(join(packageDirectory, "pass.mjs"), 'process.stdout.write(JSON.stringify({ status: "PASS", summary: "Gold met." }));\n');
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return args => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
  });
}

test("when automatic checks return mixed results, advisor text contains only actionable failure evidence", async t => {
  // Arrange
  const run = await reporterFixture(t);

  // Act
  const result = run(["automatic", "tests/downloads.test.ts", "--reporter", "text", "--failures-only"]);

  // Assert
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `FAIL publisher:alignment
  1 test-alignment violation found.
  Evidence: tests/downloads.test.ts:169: missing ordered comments
  Expected Arrange, Act, Assert.
  Next check: Add ordered comments.
`);
});

test("when JSON reporting is selected, automatic metadata and successful results remain available", async t => {
  // Arrange
  const run = await reporterFixture(t);

  // Act
  const result = run(["automatic", "tests/downloads.test.ts", "--reporter", "json"]);

  // Assert
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), [{
    id: "publisher:alignment",
    status: "FAIL",
    summary: "1 test-alignment violation found.",
    evidence: "tests/downloads.test.ts:169: missing ordered comments\nExpected Arrange, Act, Assert.",
    nextCheck: "Add ordered comments.",
    matches: [{ path: "tests/downloads.test.ts", trigger: "**/*.test.ts" }],
  }, {
    id: "publisher:pass",
    status: "PASS",
    summary: "Gold met.",
    matches: [{ path: "tests/downloads.test.ts", trigger: "**/*.test.ts" }],
  }]);
});

test("when the selected check passes, failure-only text is silent", async t => {
  // Arrange
  const run = await reporterFixture(t);

  // Act
  const result = run(["verify", "publisher:pass", "--reporter", "text", "--failures-only"]);

  // Assert
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("when no check applies, failure-only text is silent", async t => {
  // Arrange
  const run = await reporterFixture(t);

  // Act
  const result = run(["automatic", "README.md", "--reporter", "text", "--failures-only"]);

  // Assert
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("when a named check is unavailable, text reports BLOCKED instead of success", async t => {
  // Arrange
  const run = await reporterFixture(t);

  // Act
  const result = run(["verify", "publisher:missing", "--reporter", "text", "--failures-only"]);

  // Assert
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "BLOCKED publisher:missing\n  Verification check is not installed\n");
});

test("when a reporter is misspelled, the CLI rejects it instead of silently using JSON", async t => {
  // Arrange
  const run = await reporterFixture(t);

  // Act
  const result = run(["verify", "--reporter", "typo"]);

  // Assert
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
});
