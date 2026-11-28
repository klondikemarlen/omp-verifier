import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { captureDeliveryScope } from "#root/omp-plugin/delivery-scope.js";
import { verifyProjectLint } from "#root/omp-plugin/project-lint.js";
import { bindLint, installProjectEslint, makeTool, projectFixture, projectLintAdapter, writeProjectFile } from "#root/test/project-lint-fixture.js";

async function captureLintDelivery(root, paths) {
  return captureDeliveryScope({ repositoryRoot: root, baseRef: "HEAD", candidatePaths: paths });
}

function runPrLint(root, delivery, { changedPaths = delivery.changedPaths, budgetMs, env = {} } = {}) {
  const args = [fileURLToPath(projectLintAdapter)];
  if (budgetMs !== undefined) args.push(String(budgetMs));
  const execution = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      SHELLCHECK_OPTS: "",
      RUBOCOP_OPTS: "",
      PATH: `${join(root, "tools")}:${process.env.PATH}`,
      OMP_VERIFIER_CHANGED_PATHS: JSON.stringify(changedPaths),
      OMP_VERIFIER_PR_SCOPE: JSON.stringify({ version: 1, ...delivery }),
      ...env,
    },
  });
  assert.ifError(execution.error);
  const result = JSON.parse(execution.stdout);
  assert.equal(execution.status, ["BLOCKED", "FAIL"].includes(result.status) ? 1 : 0);
  return result;
}

test("when a PR changes ESLint source and config, lint narrows a broad script while retaining warning policy", async t => {
  // Arrange
  const root = await projectFixture(t);
  const selectedPath = "- selected file.js";
  const ignoredPath = "ignored file.js";
  const unrelatedPath = "unchanged-invalid.js";
  await writeProjectFile(root, unrelatedPath, "const broken = ;\n");
  execFileSync("git", ["-C", root, "add", unrelatedPath]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "track unrelated invalid source"]);
  await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { lint: "eslint . --max-warnings 0" } }));
  await writeProjectFile(root, "eslint.config.mjs", `export default [
    { ignores: [${JSON.stringify(ignoredPath)}] },
    { files: ["**/*.js", "**/*.mjs"], rules: { "no-unused-vars": "warn" } },
  ];\n`);
  await writeProjectFile(root, selectedPath, "export const selected = true;\n");
  await writeProjectFile(root, ignoredPath, "const broken = ;\n");
  await installProjectEslint(root);
  await makeTool(root, "npm", { exitCode: 2, marker: "unexpected npm script\n" });
  const delivery = await captureLintDelivery(root, [selectedPath, ignoredPath, "package.json", "eslint.config.mjs"]);

  // Act
  const scoped = runPrLint(root, delivery, { changedPaths: [...delivery.changedPaths, unrelatedPath] });
  const explicit = await verifyProjectLint({ cwd: root, changedPaths: ["package.json"] });
  await writeProjectFile(root, selectedPath, "const unused = true;\n");
  const warned = runPrLint(root, await captureLintDelivery(root, [selectedPath]));

  // Assert
  assert.equal(scoped.status, "PASS");
  assert.match(scoped.evidence, /selected file\.js/);
  assert.doesNotMatch(scoped.evidence, /ignored file\.js|unchanged-invalid\.js/);
  assert.equal(explicit.status, "FAIL");
  assert.match(explicit.evidence, /unchanged-invalid\.js/);
  assert.equal(warned.status, "FAIL");
  assert.match(warned.evidence, /no-unused-vars/);
  await assert.rejects(access(join(root, "invocations.log")));
});

test("when a PR lint script selects a directory, lint only passes changed files within that directory", async t => {
  // Arrange
  const root = await projectFixture(t);
  const selectedPath = "scripts/selected script.sh";
  const excludedPath = "other/excluded.sh";
  await writeProjectFile(root, selectedPath, "#!/bin/sh\n");
  await writeProjectFile(root, excludedPath, "#!/bin/sh\n");
  await writeProjectFile(root, "tools/shellcheck", `#!/bin/sh\nprintf '%s\\n' "$@" > invocations.log\n`);
  await chmod(join(root, "tools/shellcheck"), 0o755);
  await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { lint: "shellcheck scripts --exclude SC2034" } }));
  const delivery = await captureLintDelivery(root, [selectedPath, excludedPath]);

  // Act
  const result = runPrLint(root, delivery);

  // Assert
  assert.equal(result.status, "PASS");
  assert.equal(await readFile(join(root, "invocations.log"), "utf8"), "--exclude\nSC2034\n--\nscripts/selected script.sh\n");
});

test("when a PR changes only lint config, lint returns N/A without starting a command", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "unrelated.js", "const broken = ;\n");
  await writeProjectFile(root, "eslint.config.mjs", "export default [];\n");
  await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { lint: "eslint ." } }));
  await makeTool(root, "eslint", { marker: "unexpected eslint invocation\n" });
  const delivery = await captureLintDelivery(root, ["package.json", "eslint.config.mjs"]);

  // Act
  const result = runPrLint(root, delivery);

  // Assert
  assert.equal(result.status, "N/A");
  await assert.rejects(access(join(root, "invocations.log")));
});

for (const [kind, expectedReason] of [
  ["package lifecycle", /lifecycle hooks/],
  ["execution wrapper", /not invoke npm scripts or bypass/],
  ["opaque binding", /Cannot constrain opaque/],
  ["broad binding", /Cannot safely narrow lint target/],
  ["package glob", /Cannot safely narrow lint target/],
  ["native Go", /package-level analysis/],
]) {
  test(`when PR lint cannot narrow a ${kind}, it reports BLOCKED without executing the command`, async t => {
    // Arrange
    const root = await projectFixture(t);
    const source = kind === "native Go" ? "main.go" : "src/app.js";
    await writeProjectFile(root, source, kind === "native Go" ? "package main\n" : "export const app = true;\n");
    const marker = "unexpected lint execution\n";
    await makeTool(root, "eslint", { marker });
    await makeTool(root, "npm", { marker });
    const wrapper = await makeTool(root, "wrapper", { marker });
    if (kind === "native Go") {
      await writeProjectFile(root, ".golangci.yml", "version: '2'\n");
      await makeTool(root, "golangci-lint", { marker });
    } else if (kind === "package lifecycle") {
      await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { lint: "eslint .", prelint: "exit 2" } }));
    } else if (kind === "execution wrapper") {
      await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { lint: "eslint src" } }));
      await writeProjectFile(root, ".omp-verifier.json", JSON.stringify({ lint: { executionWrapper: [wrapper] } }));
    } else if (kind === "package glob") {
      await writeProjectFile(root, "package.json", JSON.stringify({ scripts: { lint: "eslint src/*.js" } }));
    } else {
      const command = kind === "opaque binding" ? [wrapper, "lint"] : ["eslint", "."];
      await bindLint(root, "javascript", command, { appendPaths: true });
    }
    const delivery = await captureLintDelivery(root, [source]);

    // Act
    const result = runPrLint(root, delivery);

    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, expectedReason);
    await assert.rejects(access(join(root, "invocations.log")));
  });
}

test("when a direct PR lint binding appends selected paths, it preserves each argv and excludes deletions", async t => {
  // Arrange
  const root = await projectFixture(t);
  const selectedPath = "- selected file.sh";
  const removedPath = "removed.sh";
  await writeProjectFile(root, removedPath, "#!/bin/sh\n");
  execFileSync("git", ["-C", root, "add", removedPath]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "track removed source"]);
  await rm(join(root, removedPath));
  await writeProjectFile(root, selectedPath, "#!/bin/sh\necho selected\n");
  await writeProjectFile(root, "tools/shellcheck", `#!/bin/sh\nprintf '%s\\n' "$@" > invocations.log\n`);
  await chmod(join(root, "tools/shellcheck"), 0o755);
  await bindLint(root, "shell", ["shellcheck", "--exclude", "SC2034"], { appendPaths: true });
  const delivery = await captureLintDelivery(root, [selectedPath, removedPath]);
  await writeProjectFile(root, removedPath, "#!/bin/sh\n");

  // Act
  const result = runPrLint(root, delivery);

  // Assert
  assert.deepEqual(delivery.deletedPaths, [removedPath]);
  assert.equal(result.status, "PASS");
  assert.equal(await readFile(join(root, "invocations.log"), "utf8"), "--exclude\nSC2034\n--\n./- selected file.sh\n");
});

for (const [source, bindingArguments, config, env, reason] of [
  ["a ShellCheck external-sources flag", ["-x"], {}, {}, /Lint option -x/],
  ["a ShellCheck file-list flag", ["--files-from=paths.txt"], {}, {}, /Lint option --files-from/],
  ["a ShellCheck rc file", [], { ".shellcheckrc": "external-sources=true\n" }, {}, /enables ShellCheck external sources/],
  ["SHELLCHECK_OPTS", [], {}, { SHELLCHECK_OPTS: "--files-from paths.txt" }, /SHELLCHECK_OPTS adds opaque argv/],
]) {
  test(`when ${source} can add PR lint targets, ShellCheck is not started`, async t => {
    // Arrange
    const root = await projectFixture(t);
    await writeProjectFile(root, "script.sh", "#!/bin/sh\n. ./unrelated.sh\n");
    await bindLint(root, "shell", ["shellcheck", ...bindingArguments], { appendPaths: true });
    await makeTool(root, "shellcheck", { marker: "unexpected ShellCheck execution\n" });
    for (const [path, contents] of Object.entries(config)) await writeProjectFile(root, path, contents);
    const delivery = await captureLintDelivery(root, ["script.sh"]);

    // Act
    const result = runPrLint(root, delivery, { env });

    // Assert
    assert.equal(result.status, "BLOCKED");
    assert.match(result.evidence, reason);
    await assert.rejects(access(join(root, "invocations.log")));
  });
}

test("when .rubocop supplies implicit targets, PR lint refuses to start RuboCop", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "selected.rb", "puts 'selected'\n");
  await writeProjectFile(root, ".rubocop", ".\n");
  await bindLint(root, "ruby", ["rubocop"], { appendPaths: true });
  await makeTool(root, "rubocop", { marker: "unexpected RuboCop execution\n" });
  const delivery = await captureLintDelivery(root, ["selected.rb"]);

  // Act
  const result = runPrLint(root, delivery);

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.match(result.evidence, /RuboCop adds opaque argv/);
  await assert.rejects(access(join(root, "invocations.log")));
});

test("when PR lint times out, retry guidance preserves the original delivery scope", async t => {
  // Arrange
  const root = await projectFixture(t);
  await writeProjectFile(root, "script.sh", "#!/bin/sh\n");
  await writeProjectFile(root, "tools/shellcheck", "#!/bin/sh\nsleep 2\n");
  await chmod(join(root, "tools/shellcheck"), 0o755);
  const delivery = await captureLintDelivery(root, ["script.sh"]);

  // Act
  const result = runPrLint(root, delivery, { budgetMs: 500 });

  // Assert
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.lintBudgetExhaustedMs, 500);
  assert.match(result.nextCheck, /automatic --full.*same request and scope.*--lint-budget-ms/);
  assert.match(result.nextCheck, /handoff check/);
  assert.doesNotMatch(result.nextCheck, /lint --budget-ms/);
});

