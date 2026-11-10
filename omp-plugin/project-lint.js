import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

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

function projectMarkers(family) {
  return [...family.tools.flatMap(tool => tool.configs), ...PROJECT_MARKERS[family.id]];
}

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
    if (await firstFile(directory, projectMarkers(family))) return directory;
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

function unsafeArguments(command, tool) {
  if (command.some(argument => typeof argument !== "string" || !argument || argument.includes("\0"))) return true;
  const forbidden = /^(?:--fix(?:=true)?|--fix-only|--fix-suggestions|--fix-dangerously|--init|--write(?:=true)?|--unsafe-fixes|--autocorrect(?:-all)?|--auto-correct(?:-all)?|-a|-A|install|uninstall|add|update)$/;
  // Oxlint's -A selects allowed rules; RuboCop uses the same flag for autocorrection.
  if (command.some(argument => forbidden.test(argument) && !(tool === "oxlint" && argument === "-A"))) return true;
  const binary = command[0].split(/[\\/]/).at(-1);
  if (["npx", "corepack"].includes(binary)) return true;
  if (["sh", "bash", "zsh"].includes(binary) && command.slice(1).some(argument => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(argument))) return true;
  if (["sh", "bash", "zsh", "node", "ruby", "python", "python3", "cmd", "powershell", "pwsh"].includes(binary)) {
    return command.slice(1).some(argument => ["-c", "-e", "-p", "--print", "--eval", "--command", "/c", "-command", "-encodedcommand"].includes(argument.toLowerCase()));
  }
  return false;
}

function unsafeLintArguments(tool, command) {
  if (unsafeArguments(command, tool)) return true;
  return ["oxlint", "pyflakes"].includes(tool) && command.some(argument =>
    /^(?:--help|--version|-h|-V|--print-config|--rules|--lsp|--debug)(?:=|$)/.test(argument));
}

async function projectPackageManager(pkg, root) {
  if (pkg?.packageManager) return pkg.packageManager.split("@")[0];
  if (await fileExists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(root, "yarn.lock"))) return "yarn";
  if (await fileExists(join(root, "bun.lock")) || await fileExists(join(root, "bun.lockb"))) return "bun";
  return "npm";
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

function scriptTool(script, family) {
  if (typeof script !== "string" || /[;&|`$<>'"\\\n\r]/.test(script)) return undefined;
  const words = script.trim().split(/\s+/);
  const tool = words[0] === "pyflakes3" ? "pyflakes" : words[0];
  if (!family.tools.some(candidate => candidate.id === tool) || unsafeLintArguments(tool, words)) return undefined;
  if (tool === "ruff" && (words[1] !== "check" || !words.includes("--no-fix"))) return undefined;
  if (tool === "golangci-lint" && (words[1] !== "run" || !words.includes("--fix=false"))) return undefined;
  return tool;
}

async function nativeConfiguration(directory, repositoryRoot, tool) {
  for (const owner of ancestorDirectories(directory, repositoryRoot)) {
    const name = await firstFile(owner, tool.configs);
    if (name === "pyproject.toml") {
      const source = await readFile(join(owner, name), "utf8");
      if (/^\s*\[tool\.ruff(?:\]|\.)/m.test(source)) return join(owner, name);
    } else if (name) {
      return join(owner, name);
    }
    if (tool.id === "eslint") {
      const pkg = await readJson(join(owner, "package.json"));
      if (pkg?.eslintConfig && typeof pkg.eslintConfig === "object") return `${owner}/package.json:eslintConfig`;
    }
    if (tool.id === "rubocop" && await fileExists(join(owner, "Gemfile"))) {
      const source = await readFile(join(owner, "Gemfile"), "utf8");
      if (/^\s*gem\s+["']rubocop["']/m.test(source)) return join(owner, "Gemfile");
    }
  }
  return undefined;
}

function nativeArguments(tool, paths) {
  switch (tool) {
    case "eslint": return ["--no-fix", "--", ...paths];
    case "oxlint": return ["--", ...paths];
    case "pyflakes": return paths.map(path => path.startsWith("-") ? `./${path}` : path);
    case "ruff": return ["check", "--no-fix", "--", ...paths];
    case "golangci-lint": return ["run", "--fix=false", "./..."];
    case "rubocop": return ["--force-exclusion", "--", ...paths];
    case "shellcheck": return ["--", ...paths];
  }
}

async function lintPlan(group, repositoryRoot, env) {
  const { family, root, paths, wholeProject } = group;
  const supportedTools = family.tools.map(tool => tool.id).join(", ");
  const binding = await projectBinding(root, repositoryRoot, family);
  if (binding) {
    const { tool, command, appendPaths } = binding.binding ?? {};
    if (!family.tools.some(candidate => candidate.id === tool) || !Array.isArray(command) || command.length === 0 || unsafeLintArguments(tool, command) || (appendPaths !== undefined && typeof appendPaths !== "boolean")) {
      return { result: blocked(family.id, root, `Invalid or fixing lint.commands.${family.id} binding`, `Supported tools: ${supportedTools}. Declare the actual tool and a non-fixing command argv array; appendPaths, when present, must be boolean; shell evaluation and installers are not supported.`) };
    }
    const program = await executable(command[0], binding.directory, repositoryRoot, env);
    if (!program) return { result: blocked(family.id, root, "The declared project lint command is unavailable", command[0]) };
    const sourceArguments = appendPaths ? paths.map(path => {
      const argument = relative(binding.directory, join(repositoryRoot, path));
      return argument.startsWith("-") ? `./${argument}` : argument;
    }) : [];
    return { plan: { language: family.id, tool, cwd: binding.directory, command: [program, ...command.slice(1), ...sourceArguments], paths, wholeProject, configuration: "project binding", requiresDiagnostics: ["eslint", "oxlint", "pyflakes"].includes(tool) } };
  }

  const pkg = await readJson(join(root, "package.json"));
  const scripts = Object.entries(pkg?.scripts ?? {}).filter(([name, value]) => {
    if (name !== "lint" && !name.startsWith("lint:")) return false;
    const firstWord = typeof value === "string" ? value.trim().split(/\s+/, 1)[0] : "";
    const tool = firstWord === "pyflakes3" ? "pyflakes" : firstWord;
    return !LINTER_CATALOG.some(other => other.id !== family.id && other.tools.some(candidate => candidate.id === tool));
  });
  const matches = scripts.map(([name, value]) => ({ name, value, tool: scriptTool(value, family) })).filter(script => script.tool);
  const declaredTools = scripts.map(([, value]) => typeof value === "string" ? value.trim().split(/\s+/, 1)[0] : "")
    .map(tool => tool === "pyflakes3" ? "pyflakes" : tool)
    .filter(tool => family.tools.some(candidate => candidate.id === tool));
  if (new Set(declaredTools).size > 1) {
    return { result: blocked(family.id, root, "Multiple lint tools are selected by project scripts", `Declare the intended lint.commands.${family.id} binding explicitly; Verifier will not drop one tool's checks by guessing.`) };
  }
  const script = matches[0];
  const executionWrapper = (await readJson(join(root, ".omp-verifier.json")))?.lint?.executionWrapper;
  if (executionWrapper !== undefined) {
    if (!Array.isArray(executionWrapper) || executionWrapper.length === 0 || unsafeArguments(executionWrapper)) {
      return { result: blocked(family.id, root, "Invalid or fixing lint.executionWrapper", "Declare a non-fixing executable argv prefix; shell evaluation and installers are not supported.") };
    }
    if (!script) return { result: blocked(family.id, root, "The execution wrapper requires a supported non-fixing package lint script", `Supported tools: ${supportedTools}. A binding cannot add support for a different linter; host lint will not bypass this wrapper.`) };
    const manager = await projectPackageManager(pkg, root);
    if (manager !== "npm") return { result: blocked(family.id, root, "The execution wrapper currently supports npm scripts only", manager) };
    const program = await executable(executionWrapper[0], root, repositoryRoot, env);
    if (!program) return { result: blocked(family.id, root, "The declared execution wrapper is unavailable", executionWrapper[0]) };
    const command = [program, ...executionWrapper.slice(1), "npm", "run", script.name];
    if (script.tool === "eslint") command.push("--", "--no-fix");
    return { plan: { language: family.id, tool: script.tool, cwd: root, command, paths, wholeProject, configuration: "project execution wrapper", requiresDiagnostics: ["eslint", "oxlint", "pyflakes"].includes(script.tool) } };
  }

  const wrapper = await wrapperIn(root, repositoryRoot);
  if (wrapper) return { result: blocked(family.id, root, "Project wrapper syntax is not declared for linting", `${wrapper}: declare lint.commands.${family.id} = {tool, command: [executable, ...args]} in .omp-verifier.json for a supported tool (${supportedTools}); a binding cannot add another linter. Host lint will not bypass this wrapper.`) };
  if (scripts.length && !script) return { result: blocked(family.id, root, "The existing lint script is not a supported non-fixing command", `Supported tools for ${family.label}: ${supportedTools}. Bind only an existing command for one of these tools, with its actual identity. Other linters require catalog support; a separate project check does not clear this built-in BLOCKED result. No tools or configuration were installed.`) };

  const configurations = [];
  for (const tool of family.tools) {
    if (script && script.tool !== tool.id) continue;
    const path = await nativeConfiguration(root, repositoryRoot, tool);
    if (path) configurations.push({ tool: tool.id, path });
  }
  if (!script && configurations.length > 1) {
    return { result: blocked(family.id, root, "Multiple lint tools have project configuration", `Select the intended tool through a supported package script or lint.commands.${family.id}; Verifier will not choose by PATH order.`) };
  }
  const tool = script?.tool ?? configurations[0]?.tool ?? (family.id === "shell" ? "shellcheck" : undefined);
  if (!tool || (!configurations.length && !["shellcheck", "pyflakes", "oxlint"].includes(tool))) {
    return { result: blocked(family.id, root, "No supported project lint configuration was found", `Expected existing configuration for ${supportedTools} in ${family.label}, or an explicit supported project command. A tool on PATH alone does not select it. No tools or configuration were installed.`) };
  }

  const scriptBinary = script?.value.trim().split(/\s+/, 1)[0];
  let program = await executable(scriptBinary ?? tool, root, repositoryRoot, env);
  let prefix = [];
  if (tool === "rubocop" && await fileExists(join(root, "Gemfile"))) {
    program = await executable("bundle", root, repositoryRoot, env);
    prefix = ["exec", "rubocop"];
  }
  if (!program) return { result: blocked(family.id, root, "The configured linter is unavailable", `${tool} could not be found in the project, its installed environment, or PATH. Restore the existing project setup; Verifier does not provision tools.`) };

  let command = [program, ...prefix, ...nativeArguments(tool, paths.map(path => relative(root, join(repositoryRoot, path))))];
  if (script) {
    const manager = await projectPackageManager(pkg, root);
    if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return { result: blocked(family.id, root, "The declared package manager is unsupported", manager) };
    const runner = await executable(manager, root, repositoryRoot, env);
    if (!runner) return { result: blocked(family.id, root, "The project package manager is unavailable", manager) };
    command = [runner, "run", script.name];
  }
  return { plan: { language: family.id, tool, cwd: root, command, paths, wholeProject, configuration: configurations[0]?.path ?? "Explicit tool defaults", inspectEslint: tool === "eslint", requiresDiagnostics: ["oxlint", "pyflakes"].includes(tool), executable: program } };
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
        family.sources.includes(extname(path)) || projectMarkers(family).includes(name) || name === ".omp-verifier.json");
      if (candidates.length === 0) continue;
      if (!await fileExists(absolute)) continue;
      if (!inside(repositoryRoot, await realpath(absolute))) throw new Error(`Changed source resolves outside the owning checkout: ${path}`);
      const lintConfig = name === ".omp-verifier.json" ? (await readJson(absolute))?.lint : undefined;
      for (const family of candidates) {
        const source = family.sources.includes(extname(path));
        const configuration = projectMarkers(family).includes(name);
        const verifierConfig = lintConfig?.commands?.[family.id] !== undefined || lintConfig?.executionWrapper !== undefined;
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
    const child = spawn(plan.command[0], plan.command.slice(1), {
      cwd: plan.cwd,
      env,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure;
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    const stop = () => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failure ??= error;
      }
    };
    const capture = (chunk, errorStream) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64_000) {
        failure ??= new Error("Lint output exceeded the 64000-byte capture limit");
        stop();
      } else if (errorStream) stderr += chunk;
      else stdout += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", chunk => capture(chunk, false));
    child.stderr.setEncoding("utf8").on("data", chunk => capture(chunk, true));
    child.once("error", error => { failure ??= error; });
    const timer = setTimeout(() => {
      failure ??= new Error("Project lint execution exceeded its overall time budget");
      stop();
    }, timeout);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure || code !== 0 || signal) {
        stop();
        const error = failure ?? new Error(`Lint command exited with ${signal ?? code}`);
        if (!failure) error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

function hasEslintDiagnostics(output) {
  // Explicit commands may fail before ESLint starts. Recognize findings, not exit 1 alone.
  const text = stripVTControlCharacters(output);
  if (/^\s+\d+:\d+\s+(?:error|warning)\s+\S.+$/m.test(text)) return true;

  try {
    const report = JSON.parse(text);
    const results = Array.isArray(report) ? report : report?.results;
    return Array.isArray(results) && results.some(result =>
      typeof result.filePath === "string" && Array.isArray(result.messages) &&
      result.messages.some(message => (message.severity === 1 || message.severity === 2) &&
        typeof message.message === "string" && message.message.length > 0));
  } catch {
    return false;
  }
}

function hasLintDiagnostics(tool, output) {
  if (tool === "eslint") return hasEslintDiagnostics(output);
  const text = stripVTControlCharacters(output);
  if (tool === "pyflakes") return /^[^\r\n]+\.pyi?:\d+:\d+: \S.+$/m.test(text);
  if (tool !== "oxlint") return false;
  if (hasEslintDiagnostics(text)) return true;
  if (/^[^\r\n]+:\d+:\d+: (?:warning|error) [\w/-]+(?:\([^)]+\))?: \S.+$/m.test(text)) return true;
  if (/^\s*[!×x⚠]\s+\S.+$/m.test(text)
    && /\[[^\]\r\n]+:\d+:\d+\]/.test(text)
    && /Found (?:[1-9]\d* warnings? and \d+ errors?|0 warnings? and [1-9]\d* errors?)\./.test(text)) return true;
  try {
    const report = JSON.parse(text);
    return Array.isArray(report.diagnostics) && report.diagnostics.some(diagnostic =>
      ["error", "warning"].includes(diagnostic.severity) && typeof diagnostic.filename === "string"
      && typeof diagnostic.message === "string" && diagnostic.message.length > 0);
  } catch {
    return false;
  }
}

export async function verifyProjectLint({ cwd, changedPaths, env = process.env, budgetMs = EXECUTION_BUDGET_MS }) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 600_000) {
    throw new RangeError("Project lint budget must be a whole number between 1 and 600000 milliseconds");
  }
  const deadline = Date.now() + budgetMs;
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
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
      const unprovenFailure = plan.requiresDiagnostics && !hasLintDiagnostics(plan.tool, output);
      const status = error.code === 1 && !unprovenFailure ? "FAIL" : "BLOCKED";
      const summary = status === "FAIL"
        ? `${plan.tool} reported lint violations`
        : unprovenFailure
          ? `The declared command failed without recognized ${plan.tool} diagnostics; lint execution is unverified`
          : `${plan.tool} could not complete`;
      outcomes.push({ language: plan.language, root: plan.cwd, status, summary, evidence: [plan.command.join(" "), output, error.message].filter(Boolean).join("\n") });
    }
  }
  return combinedResult(outcomes, discovery.repositoryRoot);
}
