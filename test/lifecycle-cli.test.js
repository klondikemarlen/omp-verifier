import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../bin/omp-verifier.js", import.meta.url));
const activeId = "11111111-1111-4111-8111-111111111111";
const obsoleteId = "22222222-2222-4222-8222-222222222222";

async function cliFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-lifecycle-cli-"));
  context.after(() => rm(root, {
    recursive: true,
    force: true,
  }));
  const agentDirectory = join(root, "agent");
  const runtimeRoot = join(agentDirectory, "verifier", "runtime");
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDirectory,
  };
  delete env.OMP_VERIFIER_RUNTIME_ROOT;
  delete env.OMP_VERIFIER_GENERATION;

  function run(...args) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      env,
    });
  }

  return {
    root,
    runtimeRoot,
    run,
  };
}

async function seedGeneration(runtimeRoot, id) {
  const directory = join(runtimeRoot, "generations", id);
  await mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });
  const generation = {
    id,
    protocol: 1,
    activated: true,
  };
  const serialized = JSON.stringify(generation);
  const path = join(directory, "generation.json");
  await writeFile(path, serialized);
  return generation;
}

test("when collection arguments are invalid, collectible generations remain untouched", async context => {
  // Arrange
  const fixture = await cliFixture(context);
  await seedGeneration(fixture.runtimeRoot, activeId);
  await seedGeneration(fixture.runtimeRoot, obsoleteId);
  const pointer = JSON.stringify({
    id: activeId,
  });
  await writeFile(join(fixture.runtimeRoot, "active.json"), pointer);
  const obsoletePath = join(fixture.runtimeRoot, "generations", obsoleteId, "generation.json");
  const before = await readFile(obsoletePath, "utf8");

  // Act / Assert
  for (const extraArguments of [["--base", "main"], ["unexpected"], ["--failures-only"]]) {
    const result = fixture.run("generation", "collect", ...extraArguments);

    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
    assert.equal(await readFile(obsoletePath, "utf8"), before);
  }
});

test("when generation status is requested, default and explicit actions return the active identity", async context => {
  // Arrange
  const fixture = await cliFixture(context);
  const generation = await seedGeneration(fixture.runtimeRoot, activeId);
  const pointer = JSON.stringify({
    id: activeId,
  });
  await writeFile(join(fixture.runtimeRoot, "active.json"), pointer);
  const expected = `${JSON.stringify(generation, null, 2)}\n`;

  // Act / Assert
  for (const args of [["generation"], ["generation", "status"], ["generation", "status", "--reporter", "text"]]) {
    const result = fixture.run(...args);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});

test("when handoff inputs are invalid, delivery evidence remains untouched", async context => {
  // Arrange
  const fixture = await cliFixture(context);
  const handoffPath = join(fixture.root, "handoff.json");
  const original = "untouched delivery evidence\n";
  await writeFile(handoffPath, original);
  const invalidArguments = [
    ["handoff", "prepare"],
    ["handoff", "prepare", "--base", "main", "extra"],
    ["handoff", "prepare", "--base", "main", "--reason", "not cancellation"],
    ["handoff", "recover", handoffPath, "--base", "main"],
    ["handoff", "check", handoffPath, "--base", "main"],
    ["handoff", "release", handoffPath, "--reason", "not cancellation"],
    ["handoff", "cancel", handoffPath],
    ["handoff", "cancel", handoffPath, "--reason", "   "],
    ["handoff", "cancel", handoffPath, "--reason", "user cancellation", "extra"],
  ];

  // Act / Assert
  for (const args of invalidArguments) {
    const result = fixture.run(...args);

    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
    assert.equal(await readFile(handoffPath, "utf8"), original);
  }
});

test("when valid handoff invocations lack prerequisites, results remain BLOCKED", async context => {
  // Arrange
  const fixture = await cliFixture(context);
  const missingPath = join(fixture.root, "missing-handoff.json");
  const actions = [
    ["prepare", "--base", "main"],
    ["recover", missingPath],
    ["check", missingPath],
    ["release", missingPath],
    ["cancel", missingPath, "--reason", "explicit user cancellation"],
  ];

  // Act / Assert
  for (const args of actions) {
    const result = fixture.run("handoff", ...args);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const [blocked] = JSON.parse(result.stdout);
    assert.equal(blocked.id, "verifier:delivery-handoff");
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.summary, "Delivery source handoff could not complete");
    assert.notEqual(blocked.evidence, "");
  }
});

test("when closeout inputs or prerequisites are missing, invocation errors remain distinct from BLOCKED", async context => {
  // Arrange
  const fixture = await cliFixture(context);
  const missingPath = join(fixture.root, "missing.json");
  const invalidArguments = [
    ["prepare", missingPath, "--failures-only"],
    ["prepare", missingPath, "extra"],
    ["verify", missingPath, "--reason", "irrelevant"],
    ["verify", missingPath, "extra"],
  ];

  // Act / Assert
  for (const args of invalidArguments) {
    const result = fixture.run("closeout", ...args);

    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
  }

  for (const action of ["prepare", "verify"]) {
    const result = fixture.run("closeout", action, missingPath);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, "");
    const [blocked] = JSON.parse(result.stdout);
    assert.equal(blocked.id, "verifier:resource-closeout");
    assert.equal(blocked.status, "BLOCKED");
  }
});
