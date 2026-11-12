import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createRequestIntent } from "#root/omp-plugin/request-intent.js";

const CLI = join(process.cwd(), "bin/omp-verifier.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "verifier-request-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const provider = join(root, "plugins/node_modules/publisher");
  await mkdir(project);
  await mkdir(provider, { recursive: true });
  await writeFile(join(root, "plugins/package.json"), JSON.stringify({ dependencies: { publisher: "1.0.0" } }));
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
  return { project, run, intent };
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
    },
  ]);
  assert.equal(await readFile(join(f.project, "executed.txt"), "utf8"), "required\n");
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
