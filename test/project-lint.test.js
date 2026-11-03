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

async function bindLint(root, language, command, options = {}) {
  const manifestPath = join(root, ".omp-verifier.json");
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tool = { javascript: "eslint", ruby: "rubocop", go: "golangci-lint", python: "ruff", shell: "shellcheck" }[language];
  manifest.lint = { ...manifest.lint, commands: { ...manifest.lint?.commands, [language]: { tool, command, ...options } } };
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

async function wrappedNpmProjects(t) {
  const root = await projectFixture(t);
  await writeProjectFile(root, "tools/lint wrapper.mjs", `
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
const [route, command, ...args] = process.argv.slice(2);
if (route !== basename(process.cwd()) + " service") process.exit(2);
if (command !== "npm" || JSON.stringify(args) !== JSON.stringify(["run", "lint", "--", "--no-fix"])) process.exit(2);
const result = spawnSync(command, args, { stdio: "inherit" });
process.exit(result.status ?? 2);
`);
  for (const name of ["api", "web"]) {
    await writeProjectFile(root, `${name}/package.json`, JSON.stringify({ type: "module", scripts: { lint: "eslint src --max-warnings 0" } }));
    await writeProjectFile(root, `${name}/.omp-verifier.json`, JSON.stringify({
      lint: { executionWrapper: [process.execPath, "../tools/lint wrapper.mjs", `${name} service`] },
    }));
    await writeProjectFile(root, `${name}/eslint.config.js`, `export default [{ files: ["**/*.js"], rules: ${JSON.stringify(name === "api" ? { "no-unused-vars": "error" } : { eqeqeq: "error" })} }];\n`);
    await writeProjectFile(root, `${name}/src/selected file.js`, "export const selected = true;\n");
    await installProjectEslint(join(root, name));
  }
  await writeProjectFile(root, "bin/dev", "#!/bin/sh\nexit 2\n");
  return root;
}

test("when npm lint is delegated, API and web use their own cwd, rules, and intact wrapper arguments", async t => {
  // Arrange
  const root = await wrappedNpmProjects(t);
  await writeProjectFile(root, "api/src/selected file.js", "export const equal = value => value == 1;\n");

  // Act
  const passing = await verifyProjectLint({ cwd: root, changedPaths: ["api/src/selected file.js", "web/src/selected file.js"] });
  await writeProjectFile(root, "web/src/selected file.js", "export const equal = value => value == 1;\n");
  const failing = await verifyProjectLint({ cwd: root, changedPaths: ["api/src/selected file.js", "web/src/selected file.js"] });

  // Assert
  assert.equal(passing.status, "PASS");
  assert.equal(failing.status, "FAIL");
  assert.match(failing.evidence, /javascript \(api\): PASS/);
  assert.match(failing.evidence, /javascript \(web\): FAIL/);
  assert.match(failing.evidence, /eqeqeq/);
});

test("when a binding appends selected JavaScript paths, real ESLint scopes to intact nested-cwd arguments", async t => {
  // Arrange
  const root = await projectFixture(t);
  const nested = join(root, "web");
  await writeProjectFile(root, "web/src/selected file.js", "export const selected = true;\n");
  await writeProjectFile(root, "web/-selected.js", "export const optionLookingName = true;\n");
  await writeProjectFile(root, "web/src/unrelated.js", "const unused = true;\n");
  await writeProjectFile(root, "web/eslint.config.js", `export default [{ files: ["**/*.js"], rules: { "no-unused-vars": "error" } }];\n`);
  await writeProjectFile(root, "web/tools/lint-wrapper.mjs", `
import { spawnSync } from "node:child_process";
const result = spawnSync(process.argv[2], process.argv.slice(3), { cwd: process.cwd(), stdio: "inherit" });
process.exit(result.status ?? 2);
`);
  await installProjectEslint(nested);
  await bindLint(nested, "javascript", [process.execPath, "tools/lint-wrapper.mjs", join(nested, "node_modules/.bin/eslint"), "--no-fix", "--max-warnings", "0"], { appendPaths: true });

  // Act
  const selected = await verifyProjectLint({ cwd: root, changedPaths: ["web/src/selected file.js", "web/-selected.js"] });
  const violating = await verifyProjectLint({ cwd: root, changedPaths: ["web/src/unrelated.js"] });

  // Assert
  assert.equal(selected.status, "PASS");
  assert.equal(violating.status, "FAIL");
  assert.match(violating.evidence, /no-unused-vars/);
});

test("when an append-path binding changes, it still checks the owning project's broader source", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/selected.js", "export const selected = true;\n");
  await writeProjectFile(root, "src/unrelated.js", "const unused = true;\n");
  await writeProjectFile(root, "eslint.config.mjs", `export default [{ files: ["**/*.js"], rules: { "no-unused-vars": "error" } }];\n`);
  await installProjectEslint(root);
  await bindLint(root, "javascript", [join(root, "node_modules/.bin/eslint"), "--no-fix", "--"], { appendPaths: true });

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: [".omp-verifier.json"] });

  // Assert
  assert.equal(result.status, "FAIL");
  assert.match(result.evidence, /unrelated\.js/);
});

test("when a selected binding path escapes the checkout, verification blocks rather than invoking the wrapper", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/selected.js", "export const selected = true;\n");
  await bindLint(root, "javascript", [process.execPath, "--version"], { appendPaths: true });

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["../selected.js"] });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /outside the owning checkout/);
});

test("when a binding appendPaths value is not boolean, verification blocks before execution", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/policy.js", "export const policy = true;\n");
  await bindLint(root, "javascript", ["node", "--version"], { appendPaths: "true" });

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["src/policy.js"] });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /appendPaths/);
});

test("when a binding does not append paths, its fixed full-project command still checks baseline violations", async t => {
  // Arrange
  const root = await projectFixture(t);
  const nested = join(root, "web");
  await writeProjectFile(root, "web/src/selected file.js", "export const selected = true;\n");
  await writeProjectFile(root, "web/src/unrelated.js", "const unused = true;\n");
  await writeProjectFile(root, "web/eslint.config.js", `export default [{ files: ["**/*.js"], rules: { "no-unused-vars": "error" } }];\n`);
  await installProjectEslint(nested);
  await bindLint(nested, "javascript", [join(nested, "node_modules/.bin/eslint"), "--no-fix"]);

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["web/src/selected file.js"] });

  // Assert
  assert.equal(result.status, "FAIL");
  assert.match(result.evidence, /unrelated\.js/);
});

test("when wrapper configuration changes, the npm script retains its broader project scope", async t => {
  // Arrange
  const root = await wrappedNpmProjects(t);
  await writeProjectFile(root, "api/src/unrelated.js", "const unused = true;\n");

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["api/.omp-verifier.json"] });

  // Assert
  assert.equal(result.status, "FAIL");
  assert.match(result.evidence, /unrelated\.js/);
  assert.match(result.evidence, /no-unused-vars/);
});

test("when the delegated linter cannot load its configuration, verification stays BLOCKED", async t => {
  // Arrange
  const root = await wrappedNpmProjects(t);
  await writeProjectFile(root, "api/eslint.config.js", "throw new Error('missing container lint prerequisite');\n");

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["api/src/selected file.js"] });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /missing container lint prerequisite/);
});

test("when an execution wrapper or its discovered script is unsafe or unavailable, host lint is not substituted", async t => {
  for (const { wrapper, script = "eslint src", packageManager } of [
    { wrapper: ["./missing-wrapper"] },
    { wrapper: [] },
    { wrapper: "bin/dev lint" },
    { wrapper: ["sh", "-c", "npm run lint"] },
    { wrapper: ["npm", "install"] },
    { wrapper: [process.execPath], script: "eslint src --fix" },
    { wrapper: [process.execPath], script: "eslint src && echo ok" },
    { wrapper: [process.execPath], script: "echo ok" },
    { wrapper: [process.execPath], packageManager: "pnpm@10.0.0" },
  ]) {
    // Arrange
    const root = await projectFixture(t);
    await writeProjectFile(root, "src/app.js", "export const app = true;\n");
    await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { lint: script }, packageManager }));
    await writeProjectFile(root, ".omp-verifier.json", JSON.stringify({ lint: { executionWrapper: wrapper } }));
    await makeTool(root, "eslint", { marker: "should-not-run\n" });

    // Act
    const result = await verifyProjectLint({ cwd: root, changedPaths: ["src/app.js"], env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` } });

    // Assert
    assert.equal(result.status, "BLOCKED");
    await assert.rejects(access(join(root, "invocations.log")));
  }
});

test("when a fixed binding also has an execution wrapper, the existing fixed command keeps precedence", async t => {
  // Arrange
  const root = await wrappedNpmProjects(t);
  await bindLint(join(root, "api"), "javascript", ["./missing-fixed-command"]);

  // Act
  const result = await verifyProjectLint({ cwd: root, changedPaths: ["api/src/selected file.js"] });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /declared project lint command is unavailable/);
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

test("when a Ruff script can enable fixes from configuration, discovery blocks before executing it", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "src/task.py", "import unused\n");
  await writeProjectFile(root, "ruff.toml", "fix = true\n");
  await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { "lint:python": "ruff check ." } }));
  await makeTool(root, "ruff", { marker: "unsafe-invocation\n" });

  // Act
  const result = await verifyProjectLint({
    cwd: root,
    changedPaths: ["src/task.py"],
    env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}` },
  });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /script is not a supported non-fixing command/);
  await assert.rejects(access(join(root, "invocations.log")));
});
