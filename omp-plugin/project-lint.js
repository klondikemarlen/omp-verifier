import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { LINTER_CATALOG } from "#root/omp-plugin/lint-catalog.js";
import { changedProjectPaths } from "#root/omp-plugin/verifications.js";

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE = 3_900;
const EXECUTION_BUDGET_MS = 100_000;
const PROJECT_MARKERS = {
  javascript: ["package.json"],
  ruby: ["Gemfile", "Rakefile"],
  go: ["go.mod"],
  python: ["pyproject.toml"],
  shell: [],
};

function inside(root, path) {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(difference);
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`Could not read ${path}: ${error.message}`, { cause: error });
  }
}

async function firstFile(directory, names) {
  for (const name of names) {
    if (await fileExists(join(directory, name))) return name;
  }
  return undefined;
}

function ancestorDirectories(directory, root) {
  const directories = [];
  while (inside(root, directory)) {
    directories.push(directory);
    if (directory === root) break;
    directory = dirname(directory);
  }
  return directories;
}

async function owningProject(repositoryRoot, path, family) {
  for (const directory of ancestorDirectories(dirname(path), repositoryRoot)) {
    if (await firstFile(directory, [...family.configs, ...PROJECT_MARKERS[family.id]])) return directory;
    const configuration = await readJson(join(directory, ".omp-verifier.json"));
    if (configuration?.lint?.commands?.[family.id]) return directory;
  }
  return repositoryRoot;
}

async function projectSources(repositoryRoot, directory, family) {
  const { stdout } = await execFileAsync("git", ["-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    timeout: 5_000,
    maxBuffer: 1_024_000,
  });
  const paths = [];
  for (const path of new Set(stdout.split("\0").filter(Boolean))) {
    const absolute = resolve(directory, path);
    if (!family.sources.includes(extname(path)) || !await fileExists(absolute)) continue;
    if (!inside(repositoryRoot, await realpath(absolute))) throw new Error(`Source resolves outside the owning checkout: ${path}`);
    if (await owningProject(repositoryRoot, absolute, family) !== directory) continue;
    paths.push(relative(repositoryRoot, absolute));
  }
  return paths;
}

function blocked(language, root, summary, evidence) {
  return {
    language,
    root,
    status: "BLOCKED",
    summary,
    ...(evidence ? { evidence } : {}),
  };
}

async function executable(command, cwd, repositoryRoot, env) {
  const candidates = [];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    candidates.push(resolve(cwd, command));
  } else {
    for (const directory of ancestorDirectories(cwd, repositoryRoot)) {
      candidates.push(join(directory, "node_modules", ".bin", command), join(directory, ".venv", "bin", command));
    }
    for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      candidates.push(resolve(cwd, directory, command));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (await fileExists(candidate)) return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error;
    }
  }
  return undefined;
}

function unsafeArguments(command) {
  if (command.some(argument => typeof argument !== "string" || !argument || argument.includes("\0"))) return true;
  const forbidden = /^(?:--fix(?:=true)?|--fix-only|--write(?:=true)?|--unsafe-fixes|--autocorrect(?:-all)?|--auto-correct(?:-all)?|-a|-A|install|uninstall|add|update)$/;
  if (command.some(argument => forbidden.test(argument))) return true;
  const binary = command[0].split(/[\\/]/).at(-1);
  if (["npx", "corepack"].includes(binary)) return true;
  if (["sh", "bash", "zsh"].includes(binary) && command.slice(1).some(argument => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(argument))) return true;
  if (["sh", "bash", "zsh", "node", "ruby", "python", "python3", "cmd", "powershell", "pwsh"].includes(binary)) {
    return command.slice(1).some(argument => ["-c", "-e", "-p", "--print", "--eval", "--command", "/c", "-command", "-encodedcommand"].includes(argument.toLowerCase()));
  }
  return false;
}

async function projectBinding(projectRoot, repositoryRoot, family) {
  for (const directory of ancestorDirectories(projectRoot, repositoryRoot)) {
    const config = await readJson(join(directory, ".omp-verifier.json"));
    const binding = config?.lint?.commands?.[family.id];
    if (binding !== undefined) return { binding, directory };
  }
  return undefined;
}

async function wrapperIn(projectRoot, repositoryRoot) {
  for (const directory of ancestorDirectories(projectRoot, repositoryRoot)) {
    const wrapper = await firstFile(directory, ["bin/dev", "dev"]);
    if (wrapper) return join(directory, wrapper);
  }
  return undefined;
}

function scriptMatches(script, family) {
  if (typeof script !== "string" || /[;&|`$<>'"\\\n\r]/.test(script)) return false;
  const words = script.trim().split(/\s+/);
  if (words[0] !== family.tool || unsafeArguments(words)) return false;
  if (family.tool === "ruff" && words[1] !== "check") return false;
  if (family.tool === "golangci-lint" && words[1] !== "run") return false;
  return true;
}

async function nativeConfiguration(directory, repositoryRoot, family) {
  for (const owner of ancestorDirectories(directory, repositoryRoot)) {
    const name = await firstFile(owner, family.configs);
    if (name === "pyproject.toml") {
      const source = await readFile(join(owner, name), "utf8");
      if (/^\s*\[tool\.ruff(?:\]|\.)/m.test(source)) return join(owner, name);
    } else if (name) {
      return join(owner, name);
    }
    if (family.id === "javascript") {
      const pkg = await readJson(join(owner, "package.json"));
      if (pkg?.eslintConfig && typeof pkg.eslintConfig === "object") return `${owner}/package.json:eslintConfig`;
    }
    if (family.id === "ruby" && await fileExists(join(owner, "Gemfile"))) {
      const source = await readFile(join(owner, "Gemfile"), "utf8");
      if (/^\s*gem\s+["']rubocop["']/m.test(source)) return join(owner, "Gemfile");
    }
  }
  return undefined;
}

function nativeArguments(family, paths) {
  switch (family.tool) {
    case "eslint": return ["--no-fix", "--", ...paths];
    case "ruff": return ["check", "--no-fix", "--", ...paths];
    case "golangci-lint": return ["run", "--fix=false", "./..."];
    case "rubocop": return ["--force-exclusion", "--", ...paths];
    case "shellcheck": return ["--", ...paths];
  }
}

async function lintPlan(group, repositoryRoot, env) {
  const { family, root, paths, wholeProject } = group;
  const binding = await projectBinding(root, repositoryRoot, family);
  if (binding) {
    const command = binding.binding?.command;
    if (binding.binding?.tool !== family.tool || !Array.isArray(command) || command.length === 0 || unsafeArguments(command)) {
      return { result: blocked(family.id, root, `Invalid or fixing lint.commands.${family.id} binding`, "Declare a supported tool and a non-fixing command argv array; shell evaluation and installers are not supported.") };
    }
    const program = await executable(command[0], binding.directory, repositoryRoot, env);
    if (!program) return { result: blocked(family.id, root, "The declared project lint command is unavailable", command[0]) };
    return { plan: { language: family.id, tool: family.tool, cwd: binding.directory, command: [program, ...command.slice(1)], paths, configuration: "project binding" } };
  }

  const wrapper = await wrapperIn(root, repositoryRoot);
  if (wrapper) return { result: blocked(family.id, root, "Project wrapper syntax is not declared for linting", `${wrapper}: declare lint.commands.${family.id} = {tool, command: [executable, ...args]} in .omp-verifier.json; host lint will not bypass this wrapper.`) };

  const pkg = await readJson(join(root, "package.json"));
  const scripts = Object.entries(pkg?.scripts ?? {}).filter(([name, value]) => {
    if (name !== "lint" && !name.startsWith("lint:")) return false;
    const firstWord = typeof value === "string" ? value.trim().split(/\s+/, 1)[0] : "";
    return !LINTER_CATALOG.some(other => other.id !== family.id && other.tool === firstWord);
  });
  const script = scripts.find(([, value]) => scriptMatches(value, family));
  const configuration = await nativeConfiguration(root, repositoryRoot, family);
  if (scripts.length && !script) return { result: blocked(family.id, root, "The existing lint script is not a supported non-fixing command", `The initial catalog supports ${family.tool} for ${family.label}; declare its exact existing wrapper command explicitly rather than substituting another tool.`) };
  if (!configuration && family.id !== "shell") return { result: blocked(family.id, root, "No supported project lint configuration was found", `Expected existing ${family.tool} configuration for ${family.label}; other linters may be unsupported by this initial catalog. No tools or configuration were installed.`) };

  let tool = await executable(family.tool, root, repositoryRoot, env);
  let prefix = [];
  if (family.id === "ruby" && await fileExists(join(root, "Gemfile"))) {
    tool = await executable("bundle", root, repositoryRoot, env);
    prefix = ["exec", "rubocop"];
  }
  if (!tool) return { result: blocked(family.id, root, "The configured linter is unavailable", `${family.tool} could not be found in the project, its installed environment, or PATH. Restore the existing project setup; Verifier does not provision tools.`) };

  let command = [tool, ...prefix, ...nativeArguments(family, paths.map(path => relative(root, join(repositoryRoot, path))))];
  if (script) {
    const manager = pkg.packageManager?.split("@")[0] ?? (await fileExists(join(root, "pnpm-lock.yaml")) ? "pnpm" : await fileExists(join(root, "yarn.lock")) ? "yarn" : "npm");
    if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return { result: blocked(family.id, root, "The declared package manager is unsupported", manager) };
    const runner = await executable(manager, root, repositoryRoot, env);
    if (!runner) return { result: blocked(family.id, root, "The project package manager is unavailable", manager) };
    command = [runner, "run", script[0]];
  }
  return { plan: { language: family.id, tool: family.tool, cwd: root, command, paths, wholeProject, configuration: configuration ?? "ShellCheck defaults", inspectEslint: family.id === "javascript", executable: tool } };
}

export async function discoverProjectLinters({ cwd, changedPaths, env = process.env }) {
  let repositoryRoot = resolve(cwd);
  const plans = [];
  const results = [];
  try {
    const root = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000, maxBuffer: 16_000 });
    repositoryRoot = await realpath(root.stdout.trim());
    if (changedPaths === undefined) {
      const changeSet = await changedProjectPaths(cwd);
      if (changeSet.error) throw new Error(changeSet.error);
      changedPaths = changeSet.paths;
    }
    if (!Array.isArray(changedPaths) || changedPaths.some(path => typeof path !== "string")) throw new Error("Changed paths must be a project-relative string array");
    const groups = new Map();
    for (const raw of new Set(changedPaths)) {
      const path = raw.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!path || isAbsolute(path) || path.split("/").includes("..")) throw new Error(`Changed path is outside the owning checkout: ${path}`);
      const absolute = resolve(repositoryRoot, path);
      if (!inside(repositoryRoot, absolute)) throw new Error(`Changed path is outside the owning checkout: ${path}`);
      const name = path.split("/").at(-1);
      const candidates = LINTER_CATALOG.filter(family =>
        family.sources.includes(extname(path)) || [...family.configs, ...PROJECT_MARKERS[family.id]].includes(name) || name === ".omp-verifier.json");
      if (candidates.length === 0) continue;
      if (!await fileExists(absolute)) continue;
      if (!inside(repositoryRoot, await realpath(absolute))) throw new Error(`Changed source resolves outside the owning checkout: ${path}`);
      const bindings = name === ".omp-verifier.json" ? (await readJson(absolute))?.lint?.commands : undefined;
      for (const family of candidates) {
        const source = family.sources.includes(extname(path));
        const configuration = [...family.configs, ...PROJECT_MARKERS[family.id]].includes(path.split("/").at(-1));
        const verifierConfig = bindings?.[family.id] !== undefined;
        if (!source && !configuration && !verifierConfig) continue;
        const root = await owningProject(repositoryRoot, absolute, family);
        const key = `${family.id}\0${root}`;
        if (!groups.has(key)) groups.set(key, { family, root, paths: [], wholeProject: false });
        const group = groups.get(key);
        if (source) group.paths.push(path);
        if (configuration || verifierConfig) group.wholeProject = true;
      }
    }
    for (const group of groups.values()) {
      if (group.wholeProject) group.paths = await projectSources(repositoryRoot, group.root, group.family);
    }
    for (const group of groups.values()) {
      if (group.paths.length === 0) continue;
      try {
        const discovered = await lintPlan(group, repositoryRoot, env);
        if (discovered.plan) plans.push(discovered.plan);
        else results.push(discovered.result);
      } catch (error) {
        results.push(blocked(group.family.id, group.root, "Project lint discovery could not complete", error.message));
      }
    }
  } catch (error) {
    results.push(blocked("project", repositoryRoot, "Project lint scope could not be established", error.message));
  }
  return { repositoryRoot, plans, results };
}

async function inspectEslint(plan) {
  if (!plan.inspectEslint || plan.paths.length === 0) return plan.paths;
  let modulePath;
  for (const filename of [join(plan.cwd, "package.json"), await realpath(plan.executable)]) {
    try {
      modulePath = createRequire(filename).resolve("eslint");
      break;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  if (!modulePath) throw new Error("Cannot inspect the configured ESLint rules; declare the existing delegated project command explicitly");
  const { ESLint } = await import(pathToFileURL(modulePath).href);
  const engine = new ESLint({ cwd: plan.cwd, fix: false });
  const applicable = [];
  for (const path of plan.paths) {
    const absolute = resolve(plan.repositoryRoot, path);
    const configuration = await engine.calculateConfigForFile(absolute);
    if (!configuration || await engine.isPathIgnored(absolute)) continue;
    const enabled = Object.values(configuration.rules ?? {}).some(rule => {
      const severity = Array.isArray(rule) ? rule[0] : rule;
      return severity !== 0 && severity !== "off";
    });
    if (!enabled) throw new Error(`ESLint has no enabled rules for ${path}`);
    applicable.push(path);
  }
  return applicable;
}

function combinedResult(outcomes, repositoryRoot) {
  const applicable = outcomes.filter(result => result.status !== "N/A");
  if (applicable.length === 0) return { status: "N/A", summary: "No supported changed source requires linting under the detected project configuration" };
  let status = "PASS";
  if (applicable.some(result => result.status === "BLOCKED")) status = "BLOCKED";
  if (applicable.some(result => result.status === "FAIL")) status = "FAIL";
  const headers = outcomes.map(result => `${result.language} (${relative(repositoryRoot, result.root) || "."}): ${result.status} — ${result.summary}`);
  const headerBytes = headers.join("\n").length;
  if (headerBytes > MAX_EVIDENCE) return { status: "BLOCKED", summary: "Project lint outcomes exceed the bounded result transport", evidence: `${outcomes.length} project/language outcomes cannot be represented within ${MAX_EVIDENCE} characters; no combined lint approval was issued.` };
  const perOutcome = Math.max(0, Math.floor((MAX_EVIDENCE - headerBytes - outcomes.length * 3) / outcomes.length));
  const evidence = outcomes.map((result, index) => {
    const detail = result.evidence ?? "";
    const bounded = detail.length > perOutcome ? `${detail.slice(0, Math.max(0, perOutcome - 20))} [output truncated]` : detail;
    return `${headers[index]}${bounded ? `\n${bounded}` : ""}`;
  }).join("\n");
  return {
    status,
    summary: `Lint execution for ${applicable.length} applicable project/language group(s)`,
    evidence,
    ...(status === "PASS" ? {} : { nextCheck: "Resolve each reported violation or unavailable project/tooling prerequisite, then rerun verifier:project-lint." }),
  };
}

function executeLint(plan, env, timeout) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const stop = () => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    const child = execFile(plan.command[0], plan.command.slice(1), {
      cwd: plan.cwd,
      env,
      detached: grouped,
      maxBuffer: 64_000,
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) {
        stop();
        reject(error);
      } else resolve({ stdout, stderr });
    });
    const timer = setTimeout(stop, timeout);
  });
}

export async function verifyProjectLint({ cwd, changedPaths, env = process.env }) {
  const deadline = Date.now() + EXECUTION_BUDGET_MS;
  const discovery = await discoverProjectLinters({ cwd, changedPaths, env });
  const outcomes = [...discovery.results];
  for (const plan of discovery.plans) {
    try {
      plan.repositoryRoot = discovery.repositoryRoot;
      const applicable = await inspectEslint(plan);
      if (plan.inspectEslint && applicable.length === 0) {
        outcomes.push({ language: plan.language, root: plan.cwd, status: "N/A", summary: "Changed source is outside the configured ESLint scope" });
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Project lint execution exceeded its overall time budget");
      const { stdout, stderr } = await executeLint(plan, env, remaining);
      outcomes.push({ language: plan.language, root: plan.cwd, status: "PASS", summary: "The existing non-fixing lint command exited 0", evidence: [stdout, stderr].filter(Boolean).join("\n") || plan.command.join(" ") });
    } catch (error) {
      const status = error.code === 1 ? "FAIL" : "BLOCKED";
      outcomes.push({ language: plan.language, root: plan.cwd, status, summary: status === "FAIL" ? `${plan.tool} reported lint violations` : `${plan.tool} could not complete`, evidence: [error.stdout, error.stderr, error.message].filter(Boolean).join("\n") });
    }
  }
  return combinedResult(outcomes, discovery.repositoryRoot);
}
