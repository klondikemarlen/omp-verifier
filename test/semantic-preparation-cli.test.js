import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CLI = join(process.cwd(), "bin", "omp-verifier.js");
const POLICY_SOURCE = "export function positive(value) { if (value <= 0) throw new RangeError(); return value; }\n";

async function preparationFixture(t, checkIds = ["publisher:alignment"], includeBlockedCheck = false) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = join(root, "plugins", "node_modules", "publisher");
  await mkdir(provider, { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "policy.js"), POLICY_SOURCE);
  await writeFile(join(root, "src", "obsolete.js"), "export const obsolete = true;\n");
  await writeFile(join(provider, "standard.md"), "The changed positive function rejects non-positive inputs.\n");
  const verifications = [];
  for (const id of checkIds) {
    const contract = `./${id.split(":")[1]}.json`;
    await writeFile(join(provider, contract), JSON.stringify({
      version: 1,
      standardId: id,
      source: "./standard.md",
      gold: "The positive function rejects non-positive inputs.",
      requiredContext: ["changed-code"],
      rubric: [{ id: "validation", question: "Does positive enforce its input invariant?" }],
    }));
    verifications.push({
      id,
      label: "Positive Validation",
      description: "Assesses the supplied validation contract.",
      mode: "agentic",
      contract,
      pathTriggers: ["src/*.js"],
    });
  }
  if (includeBlockedCheck) {
    await writeFile(join(provider, "blocked.mjs"), `
process.stdout.write(JSON.stringify({
  status: "BLOCKED",
  summary: "A required comparison base is unavailable.",
}));
process.exitCode = 1;
`);
    verifications.push({
      id: "publisher:baseline",
      label: "Baseline",
      description: "Requires an available comparison base.",
      entry: "./blocked.mjs",
      pathTriggers: ["src/*.js"],
    });
  }
  await writeFile(join(provider, "package.json"), JSON.stringify({
    name: "publisher",
    version: "1.0.0",
    omp: { extensions: ["./index.js"], verifications },
  }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Verifier Tests", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "baseline"], { cwd: root });
  await rm(join(root, "src", "obsolete.js"));
  return {
    run: args => spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    }),
    runCommand: (command, input) => spawnSync(command, {
      shell: true,
      cwd: root,
      encoding: "utf8",
      input,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
    }),
  };
}

test("when preparation returns one pending review, its first text response exposes current code and authenticated deletions", async t => {
  // Arrange
  const fixture = await preparationFixture(t);

  // Act
  const prepared = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--reporter", "text", "--failures-only",
  ]);

  // Assert
  assert.equal(prepared.status, 3);
  const fragment = prepared.stdout.split("JSON fragment:\n")[1].split("\nNext page index:")[0].replaceAll("\\\n", "");
  const result = JSON.parse(fragment)[0];
  assert.equal(result.status, "PENDING");
  assert.deepEqual(result.reviewRequest.scope.changedPaths, ["src/obsolete.js", "src/policy.js"]);
  assert.deepEqual(result.reviewRequest.context.changedCode.find(record => record.path === "src/policy.js").content, {
    1: POLICY_SOURCE.trim(),
    2: "",
  });
  assert.equal(result.reviewRequest.context.changedCode.find(record => record.path === "src/obsolete.js").state, "deleted");
});

test("when preparation returns multiple pending reviews, each handle remains separately inspectable without concatenated pages", async t => {
  // Arrange
  const fixture = await preparationFixture(t, ["publisher:first", "publisher:second"]);

  // Act
  const prepared = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--reporter", "text", "--failures-only",
  ]);

  // Assert
  assert.equal(prepared.status, 3);
  assert.deepEqual(prepared.stdout.match(/^PENDING publisher:[a-z]+$/gm), [
    "PENDING publisher:first",
    "PENDING publisher:second",
  ]);
  assert.equal(prepared.stdout.includes("Semantic review page"), false);
  const paths = [...prepared.stdout.matchAll(/^  Review request: (.+)$/gm)].map(match => match[1]);
  const inspected = paths.map(path => fixture.run(["review", path]));
  assert.deepEqual(inspected.map(result => JSON.parse(result.stdout)[0].id), [
    "publisher:first",
    "publisher:second",
  ]);
});

test("when a final review page supplies evaluation, its command consumes the current request before silent completion", async t => {
  // Arrange
  const fixture = await preparationFixture(t);
  const prepared = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--reporter", "text", "--failures-only",
  ]);
  const fragment = prepared.stdout.split("JSON fragment:\n")[1].split("\nNext page index:")[0].replaceAll("\\\n", "");
  const result = JSON.parse(fragment)[0];
  const nextCommand = prepared.stdout.match(/^Next command: (.+)$/m)[1];
  const assessment = `${JSON.stringify({
    requestId: result.reviewRequest.requestId,
    status: "PASS",
    summary: "The positive function rejects non-positive inputs.",
    rationale: "Its explicit value <= 0 guard throws before returning the input.",
    citations: [
      {
        path: "src/policy.js",
        line: 1,
        quote: POLICY_SOURCE.trim(),
      },
    ],
  })}\n`;

  // Act
  const evaluated = fixture.runCommand(nextCommand, assessment);
  const replay = fixture.runCommand(nextCommand, assessment);

  // Assert
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.equal(evaluated.stdout, "");
  assert.equal(replay.status, 1, replay.stderr);
  assert.match(replay.stdout, /^BLOCKED publisher:alignment$/m);
});

test("when pending review and final blocked checks are mixed, failure-only retains both and final BLOCKED wins", async t => {
  // Arrange
  const fixture = await preparationFixture(t, ["publisher:alignment"], true);

  // Act
  const result = fixture.run([
    "automatic", "src/policy.js", "src/obsolete.js",
    "--reporter", "text", "--failures-only",
  ]);

  // Assert
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^PENDING publisher:alignment$/m);
  assert.match(result.stdout, /^BLOCKED publisher:baseline$/m);
});
