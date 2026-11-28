import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const projectLintAdapter = import.meta.resolve("#root/omp-plugin/project-lint-check.mjs");

export async function projectFixture(t) {
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

export async function writeProjectFile(root, path, content) {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}

export async function bindLint(root, language, command, options = {}) {
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

export async function installProjectEslint(root) {
  const bin = join(root, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await symlink(join(fileURLToPath(new URL("..", import.meta.url)), "node_modules", ".bin", "eslint"), join(bin, "eslint"));
}

export async function makeTool(root, name, { exitCode = 0, marker = "", stdout = "", stderr = "" } = {}) {
  const bin = join(root, "tools");
  await mkdir(bin, { recursive: true });
  const tool = join(bin, name);
  await writeFile(tool, `#!/bin/sh\nprintf '%b' ${JSON.stringify(marker)} >> ${JSON.stringify(join(root, "invocations.log"))}\nprintf '%b' ${JSON.stringify(stdout)}\nprintf '%b' ${JSON.stringify(stderr)} >&2\nexit ${exitCode}\n`);
  await chmod(tool, 0o755);
  return tool;
}

