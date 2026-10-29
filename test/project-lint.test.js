import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { runAutomaticVerification, runInstalledVerificationChecks } from "#root/omp-plugin/verifications.js";
import { discoverProjectLinters, verifyProjectLint } from "#root/omp-plugin/project-lint.js";

async function projectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-verifier-project-lint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "lint-test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Project lint test"]);
  await writeFile(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  return root;
}

async function writeProjectFile(root, path, content) {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}

async function bindLint(root, language, command) {
  const manifestPath = join(root, ".omp-verifier.json");
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tool = { javascript: "eslint", ruby: "rubocop", go: "golangci-lint", python: "ruff", shell: "shellcheck" }[language];
  manifest.lint = { ...manifest.lint, commands: { ...manifest.lint?.commands, [language]: { tool, command } } };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const projectLintAdapter = pathToFileURL(fileURLToPath(new URL("../omp-plugin/project-lint-check.mjs", import.meta.url))).href;

async function verificationPackage(t, source) {
  const packageDirectory = await mkdtemp(join(tmpdir(), "omp-verifier-project-lint-checks-"));
  t.after(() => rm(packageDirectory, { recursive: true, force: true }));
  const packagePath = join(packageDirectory, "fixture-lint-consumer");
  await mkdir(packagePath);
  await writeFile(join(packagePath, "package.json"), JSON.stringify({
    name: "fixture-lint-consumer",
    omp: {
      extensions: ["./index.js"],
      verifications: [{
        id: "fixture-lint-consumer:check",
        label: "Project lint integration",
        description: "Run project lint through the verifier coordinator",
        entry: "./check.mjs",
        pathTriggers: ["**/*.js"],
      }],
    },
  }));
  await writeFile(join(packagePath, "check.mjs"), source);
  return packageDirectory;
}

function projectLintCheckSource() {
  return `await import(${JSON.stringify(projectLintAdapter)});\n`;
}

async function installProjectEslint(root) {
  const bin = join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await symlink(join(fileURLToPath(new URL("..", import.meta.url)), "node_modules", ".bin", "eslint"), join(bin, "eslint"));
}

test("when lint has no applicable project paths, automatic and manual consumers omit N/A", async t => {
  // Arrange
  const root = await projectFixture(t);
  const packageDirectory = await verificationPackage(t, projectLintCheckSource());
  await writeProjectFile(root, "package.json", JSON.stringify({ name: "ignored-lint-fixture", type: "module" }));
  await writeProjectFile(root, "eslint.config.mjs", `export default [
  { ignores: ["src/ignored.js"] },
  { files: ["**/*.js"], rules: { "no-unused-vars": "error" } },
];
`);
  await writeProjectFile(root, "src/ignored.js", "const unused = true;\n");
  execFileSync("git", ["-C", root, "add", "package.json", "eslint.config.mjs"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "add ignored lint configuration"]);

  await installProjectEslint(root);

  // Act
  const automatic = await runAutomaticVerification({
    cwd: root,
    repositoryRoot: root,
    changedPaths: ["src/ignored.js"],
    packageDirectory,
  });
  const manual = await runInstalledVerificationChecks({ cwd: root, packageDirectory });

  // Assert
  assert.deepEqual(automatic, []);
  assert.deepEqual(manual, []);
});

test("when a lint check returns N/A but exits unsuccessfully, consumers preserve the execution failure", async t => {
  // Arrange
  const root = await projectFixture(t);
  const packageDirectory = await verificationPackage(t, `process.stdout.write(JSON.stringify({ status: "N/A", summary: "No lint work applies" }));\nprocess.exitCode = 1;\n`);
  await writeProjectFile(root, "src/policy.js", "export const policy = true;\n");

  // Act
  const automatic = await runAutomaticVerification({
    cwd: root,
    repositoryRoot: root,
    changedPaths: ["src/policy.js"],
    packageDirectory,
  });
  const manual = await runInstalledVerificationChecks({ cwd: root, packageDirectory });

  // Assert
  assert.equal(automatic.length, 1);
  assert.equal(automatic[0].status, "BLOCKED");
  assert.match(automatic[0].summary, /exited with code 1/i);
  assert.equal(manual.length, 1);
  assert.equal(manual[0].status, "BLOCKED");
  assert.match(manual[0].summary, /exited with code 1/i);
});

async function makeTool(root, name, { exitCode = 0, marker = "", stdout = "", stderr = "" } = {}) {
  const bin = join(root, "tools");
  await mkdir(bin, { recursive: true });
  const tool = join(bin, name);
  await writeFile(tool, `#!/bin/sh\nprintf '%b' ${JSON.stringify(marker)} >> ${JSON.stringify(join(root, "invocations.log"))}\nprintf '%b' ${JSON.stringify(stdout)}\nprintf '%b' ${JSON.stringify(stderr)} >&2\nexit ${exitCode}\n`);
  await chmod(tool, 0o755);
  return tool;
}

test("when changed untracked JavaScript has no supported lint configuration, verification returns BLOCKED", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/policy.js", "const value = 1;\n");
  const untracked = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  assert.match(untracked, /\?\? src\/policy\.js/);

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["src/policy.js"], env: { ...process.env, PATH: "" } });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.summary, /javascript|eslint|lint/i);
});

test("when a script merely contains a lint-like name, unsupported JavaScript lint is BLOCKED", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { "lint:javascript": "echo clean" } }));
  await writeProjectFile(root, "src/policy.js", "const value = 1;\n");

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["package.json", "src/policy.js"], env: { ...process.env, PATH: "" } });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(`${result.summary} ${result.evidence ?? ""}`, /unsupported|eslint|configuration|tool/i);
});

test("when explicit changed paths cover mixed configured languages, lint failure and unavailable tooling both survive", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/policy.js", "export const policy = true;\n");
  await writeProjectFile(root, "src/task.py", "value = 1\n");
  await bindLint(root, "javascript", ["eslint", "--no-fix"]);
  await makeTool(root, "eslint", { exitCode: 1, marker: "eslint\n", stderr: "src/policy.js: error\n" });

  // Act
  const result = await verifyProjectLint({
    cwd: root,
    changedPaths: ["src/policy.js", "src/task.py"],
    env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` },
  });

  // Assert
  assert.equal(result.status, "FAIL");
  assert.match(`${result.summary} ${result.evidence ?? ""}`, /javascript|eslint/i);
  assert.match(`${result.summary} ${result.evidence ?? ""}`, /python|ruff/i);
  assert.match(await readFile(join(root, "invocations.log"), "utf8"), /^eslint\n$/);
});

test("when ShellCheck is found on PATH, its successful and violation exit codes become PASS and FAIL", async t => {
  // Arrange
  for (const { exitCode, expectedStatus } of [{ exitCode: 0, expectedStatus: "PASS" }, { exitCode: 1, expectedStatus: "FAIL" }]) {
    const root = await projectFixture(t);
    await writeProjectFile(root, "scripts/check.sh", "#!/bin/sh\necho check\n");
    await makeTool(root, "shellcheck", {
      exitCode,
      marker: "shellcheck\n",
      stderr: exitCode === 1 ? "scripts/check.sh:1:1: warning: fixture violation\n" : "",
    });

    // Act
    const result = await verifyProjectLint({
      cwd: root,
      changedPaths: ["scripts/check.sh"],
      env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` },
    });

    // Assert
    assert.equal(result.status, expectedStatus);
    assert.equal(await readFile(join(root, "invocations.log"), "utf8"), "shellcheck\n");
  }
});

test("when explicit scope excludes another dirty source, discovery keeps only the caller's paths", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/selected.js", "export const selected = true;\n");
  await writeProjectFile(root, "src/unselected.py", "value = 1\n");
  await bindLint(root, "javascript", ["eslint", "--no-fix"]);
  await makeTool(root, "eslint", { marker: "eslint\n" });

  // Act
  const discovered = await discoverProjectLinters({ cwd: root, changedPaths: ["src/selected.js"], env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` } });

  // Assert
  assert.equal(discovered.plans.length, 1);
  assert.deepEqual(discovered.plans[0].paths, ["src/selected.js"]);
  assert.equal(discovered.plans[0].language, "javascript");
});

test("when the lint manifest changes, its declared language selects its source project", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/policy.js", "export const policy = true;\n");
  await bindLint(root, "javascript", ["eslint", "--no-fix"]);
  await makeTool(root, "eslint", { marker: "eslint\n" });

  // Act
  const discovered = await discoverProjectLinters({ cwd: root, changedPaths: [".omp-verifier.json"], env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` } });

  // Assert
  assert.equal(discovered.plans.length, 1);
  assert.equal(discovered.plans[0].language, "javascript");
});

test("when a wrapper-backed project has a trusted linter binding, verification runs that binding", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/policy.js", "export const policy = true;\n");
  await writeProjectFile(root, "bin/dev", "#!/bin/sh\nexit 0\n");
  await bindLint(root, "javascript", ["eslint", "--no-fix"]);
  await makeTool(root, "eslint", { marker: "eslint\n" });

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["src/policy.js"], env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` } });

  // Assert
  assert.equal(result.status, "PASS");
  assert.equal(await readFile(join(root, "invocations.log"), "utf8"), "eslint\n");
});


test("when only a deleted supported source is in scope, verification does not invoke a linter", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/removed.js", "export const removed = true;\n");
  execFileSync("git", ["-C", root, "add", "src/removed.js"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "track source"]);
  await rm(join(root, "src/removed.js"));
  await bindLint(root, "javascript", ["eslint", "--no-fix"]);
  await makeTool(root, "eslint", { marker: "unexpected\n" });

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["src/removed.js"], env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` } });

  // Assert
  assert.equal(result.status, "N/A");
  await assert.rejects(access(join(root, "invocations.log")));
});

test("when a nested project owns changed source, its lint command runs from that project root", async t => {
  // Arrange
  const root = await projectFixture(t);
  const nested = join(root, "web");
  await writeProjectFile(root, "web/src/app.js", "export const app = true;\n");
  await writeProjectFile(root, "web/eslint.config.js", "export default [];\n");
  await writeProjectFile(root, "web/package.json", JSON.stringify({ name: "web", scripts: { lint: "eslint src" } }));
  await bindLint(nested, "javascript", ["eslint", "--no-fix"]);
  await makeTool(root, "eslint", { marker: "eslint\n" });

  // Act
  const discovered = await discoverProjectLinters({ cwd: root, changedPaths: ["web/src/app.js"], env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` } });

  // Assert
  assert.equal(discovered.plans.length, 1);
  assert.equal(discovered.plans[0].cwd, nested);
  assert.deepEqual(discovered.plans[0].paths, ["web/src/app.js"]);
});

test("when a project wrapper exists without an explicit safe binding, host lint is not bypassed", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/policy.js", "export const policy = true;\n");
  await writeProjectFile(root, "bin/dev", "#!/bin/sh\nexit 0\n");
  await makeTool(root, "eslint", { marker: "should-not-run\n" });

  // Act
  const discovered = await discoverProjectLinters({ cwd: root, changedPaths: ["src/policy.js"], env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` } });

  // Assert
  assert.equal(discovered.plans.length, 0);
  assert.ok(discovered.results.some(result => result.status === "BLOCKED"));
});

test("when a trusted binding requests an autofix flag, verification blocks without invoking it", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/policy.js", "export const policy = true;\n");
  await bindLint(root, "javascript", ["eslint", "--fix"]);
  await makeTool(root, "eslint", { marker: "should-not-run\n" });

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["src/policy.js"], env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` } });

  // Assert
  assert.equal(result.status, "BLOCKED");
  await assert.rejects(access(join(root, "invocations.log")));
});

test("when root lint configuration changes, source owned by a nested project stays outside its scope", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/root.js", "export const root = true;\n");
  await writeProjectFile(root, ".eslintrc.json", "{}\n");
  await writeProjectFile(root, "web/package.json", JSON.stringify({ name: "web" }));
  await writeProjectFile(root, "web/src/app.js", "export const app = true;\n");
  await makeTool(root, "eslint");

  // Act
  const discovered = await discoverProjectLinters({
    cwd: root,
    changedPaths: [".eslintrc.json"],
    env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` },
  });

  // Assert
  assert.deepEqual(discovered.plans.map(plan => plan.paths), [["src/root.js"]]);
  assert.deepEqual(discovered.plans[0].command.slice(1), ["--no-fix", "--", "src/root.js"]);
});

test("when changed lint configuration owns no source, verification does not invoke a linter", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, ".eslintrc.json", "{}\n");
  await makeTool(root, "eslint", { marker: "unexpected\n" });

  // Act
  const result = await verifyProjectLint({
    cwd: root,
    changedPaths: [".eslintrc.json"],
    env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` },
  });

  // Assert
  assert.equal(result.status, "N/A");
  await assert.rejects(access(join(root, "invocations.log")));
});
