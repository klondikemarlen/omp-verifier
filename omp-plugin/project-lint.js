import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

import { LINTER_CATALOG } from "#root/omp-plugin/lint-catalog.js";
import { lintVerdictRows } from "#root/omp-plugin/lint-presentation.js";
import { markVerificationTimeout, verificationCancellationSignal } from "#root/omp-plugin/run-timings.js";
import { currentVerificationRestart } from "#root/omp-plugin/verification-restart.js";
import {
  changedProjectPaths,
  DEFAULT_PROJECT_LINT_BUDGET_MS,
  MAX_PROJECT_LINT_BUDGET_MS,
  validateProjectLintBudget,
} from "#root/omp-plugin/verifications.js";

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE = 3_900;
const MAX_LINT_STREAM_BYTES = 32_000;
const LINT_OUTPUT_TRUNCATED = `Lint output truncated (${MAX_LINT_STREAM_BYTES * 2}-byte retention limit; ${MAX_LINT_STREAM_BYTES} bytes per stream)`;
const MAX_LINT_COMMAND_DISPLAY = 320;
const MAX_LINT_STREAM_EXCERPT = 600;
const MAX_FINDING_DISPLAY = 360;
const MAX_RESTART_EVIDENCE = MAX_EVIDENCE + 1;
const MAX_RESTART_ARGUMENTS = 64;
const lintProviderPath = fileURLToPath(new URL("./project-lint-check.mjs", import.meta.url));
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
  const { family, root, paths, wholeProjectTrigger } = group;
  const wholeProject = wholeProjectTrigger !== undefined;
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
    const restartArguments = command.slice(1);
    return {
      plan: {
        language: family.id,
        tool,
        cwd: binding.directory,
        command: [program, ...restartArguments, ...sourceArguments],
        paths,
        wholeProject,
        configuration: "project binding",
        requiresDiagnostics: ["eslint", "oxlint", "pyflakes"].includes(tool),
        restartArguments,
      },
    };
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

    // The wrapper may run npm and its linter outside the host's tooling.
    return {
      plan: {
        language: family.id,
        tool: script.tool,
        cwd: root,
        command,
        paths,
        wholeProject,
        configuration: "project execution wrapper",
        requiresDiagnostics: ["eslint", "oxlint", "pyflakes"].includes(script.tool),
        restartDisabled: true,
      },
    };
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
  let restartDisabled = prefix.length > 0;
  if (script) {
    const manager = await projectPackageManager(pkg, root);
    if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) return { result: blocked(family.id, root, "The declared package manager is unsupported", manager) };
    const runner = await executable(manager, root, repositoryRoot, env);
    if (!runner) return { result: blocked(family.id, root, "The project package manager is unavailable", manager) };
    command = [runner, "run", script.name];
    // A delegated script can select another executable or run arbitrary lifecycle hooks.
    restartDisabled ||= program !== join(root, "node_modules", ".bin", scriptBinary)
      || Object.hasOwn(pkg.scripts, `pre${script.name}`)
      || Object.hasOwn(pkg.scripts, `post${script.name}`);
  }
  return {
    plan: {
      language: family.id,
      tool,
      cwd: root,
      command,
      paths,
      wholeProject,
      configuration: configurations[0]?.path ?? "Explicit tool defaults",
      inspectEslint: tool === "eslint",
      requiresDiagnostics: ["oxlint", "pyflakes"].includes(tool),
      executable: program,
      restartDisabled,
    },
  };
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
        if (!groups.has(key)) {
          groups.set(key, {
            family,
            root,
            paths: [],
          });
        }
        const group = groups.get(key);
        if (source) group.paths.push(path);
        // Prefer the manifest when several edits select the same whole-project run.
        if ((configuration || verifierConfig) && (!group.wholeProjectTrigger || PROJECT_MARKERS[family.id].includes(name))) {
          group.wholeProjectTrigger = name;
        }
      }
    }
    for (const group of groups.values()) {
      if (group.wholeProjectTrigger) {
        group.paths = await projectSources(repositoryRoot, group.root, group.family);
      }
    }
    for (const group of groups.values()) {
      if (group.paths.length === 0) continue;

      const { root, wholeProjectTrigger } = group;
      try {
        const discovered = await lintPlan(group, repositoryRoot, env);
        if (discovered.plan) {
          plans.push({
            ...discovered.plan,
            root,
            wholeProjectTrigger,
          });
        } else {
          results.push({
            ...discovered.result,
            wholeProjectTrigger,
            execution: "discovery",
          });
        }
      } catch (error) {
        results.push({
          ...blocked(group.family.id, root, "Project lint discovery could not complete", error.message),
          wholeProjectTrigger,
          execution: "discovery",
        });
      }
    }
  } catch (error) {
    results.push({
      ...blocked("project", repositoryRoot, "Project lint scope could not be established", error.message),
      execution: "discovery",
    });
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

function lintGroupLabel(result, repositoryRoot, maxRootLength = Infinity) {
  const relativeRoot = relative(repositoryRoot, result.root) || ".";
  let root = JSON.stringify(relativeRoot).slice(1, -1);
  if (root.length > maxRootLength) {
    const endLength = Math.floor((maxRootLength - 3) / 2);
    root = `${root.slice(0, maxRootLength - endLength - 3)}...${root.slice(-endLength)}`;
  }

  return `${result.language} (${root})`;
}

function lintTimeoutSummary(outcomes, repositoryRoot, budgetMs) {
  const categories = [
    ["Interrupted", result => result.execution === "interrupted"],
    ["Never started", result => result.execution === "not-started"],
    ["Finished PASS", result => result.status === "PASS" && result.execution !== "restored"],
    ["Finished FAIL (lint violations)", result => result.status === "FAIL"],
    ["Restored PASS", result => result.execution === "restored"],
    ["Discovery BLOCKED", result => result.execution === "discovery"],
    ["Other BLOCKED", result => result.status === "BLOCKED" && !result.execution],
    ["Not applicable", result => result.status === "N/A"],
    ["Whole-project lint selected by manifest or lint config",
      result => result.wholeProjectTrigger, result => ` via ${result.wholeProjectTrigger}`],
    ["Findings reported before interruption", result => result.reportedFindings],
  ];
  const summary = [`Shared project lint budget of ${budgetMs} ms expired`];
  for (const [heading, matches, suffix] of categories) {
    const groups = outcomes.filter(matches);
    if (groups.length === 0) continue;

    const labels = groups.slice(0, 3).map(group => lintGroupLabel(group, repositoryRoot, 72) + (suffix?.(group) ?? ""));
    if (groups.length > labels.length) {
      labels.push(`+${groups.length - labels.length} more`);
    }

    summary.push(`${heading}: ${labels.join(", ")}`);
  }
  if (outcomes.some(result => result.execution === "interrupted") && !outcomes.some(result => result.reportedFindings)) {
    summary.push("No findings recognized in the interrupted output");
  }

  return summary.join("; ");
}

function lintVerdictSummary(outcomes, repositoryRoot, exhaustedBudgetMs) {
  const rows = [];
  const canIncreaseBudget = exhaustedBudgetMs < MAX_PROJECT_LINT_BUDGET_MS;
  for (const status of ["FAIL", "BLOCKED"]) {
    for (const outcome of outcomes) {
      if (outcome.status !== status) continue;

      const label = lintGroupLabel(outcome, repositoryRoot);
      rows.push(...lintVerdictRows(outcome, label, {
        canIncreaseBudget,
      }));
    }
  }
  return rows.join("\n");
}

function combinedResult(outcomes, repositoryRoot, exhaustedBudgetMs) {
  const applicable = outcomes.filter(result => result.status !== "N/A");
  if (applicable.length === 0) return { status: "N/A", summary: "No supported changed source requires linting under the detected project configuration" };
  let status = "PASS";
  if (applicable.some(result => result.status === "BLOCKED")) status = "BLOCKED";
  if (applicable.some(result => result.status === "FAIL")) status = "FAIL";

  let summary = `Lint execution for ${applicable.length} applicable project/language group(s)`;
  let nextCheck = "Resolve each reported violation or unavailable project/tooling prerequisite, then rerun verifier:project-lint.";
  if (exhaustedBudgetMs !== undefined) {
    summary = lintTimeoutSummary(outcomes, repositoryRoot, exhaustedBudgetMs);
    if (exhaustedBudgetMs < MAX_PROJECT_LINT_BUDGET_MS) {
      nextCheck = `For \`automatic --full\`, retry the same request and scope from the same checkout (including any base and paths) with a larger \`--lint-budget-ms <milliseconds>\` (maximum ${MAX_PROJECT_LINT_BUDGET_MS} ms). For an applicable handoff, retry \`handoff check <same-handoff-file> --lint-budget-ms <milliseconds>\`. For lint alone, use \`lint --budget-ms <milliseconds>\` with the same lint-selected paths.`;
    } else {
      nextCheck = "The lint budget is already at its maximum. Investigate the slow command before retrying the same scope.";
    }
    if (status === "FAIL") {
      nextCheck = `Resolve the reported lint violations. ${nextCheck}`;
    }
  }

  const headers = outcomes.map(result => [
    `${lintGroupLabel(result, repositoryRoot)}: ${result.status} — ${result.summary}`,
    result.executionReason,
    result.outputTruncated ? LINT_OUTPUT_TRUNCATED : undefined,
  ].filter(Boolean).join("\n"));
  const headerLength = headers.join("\n").length;
  if (headerLength > MAX_EVIDENCE) {
    const evidence = `${outcomes.length} project/language outcomes cannot be represented within ${MAX_EVIDENCE} characters; no combined lint approval was issued.`;
    if (exhaustedBudgetMs !== undefined) {
      return {
        status,
        summary,
        evidence,
        nextCheck,
      };
    }
    return {
      status: "BLOCKED",
      summary: "Project lint outcomes exceed the bounded result transport",
      evidence,
    };
  }
  const perOutcome = Math.max(0, Math.floor((MAX_EVIDENCE - headerLength - outcomes.length * 3) / outcomes.length));
  const evidence = outcomes.map((result, index) => {
    let detail = result.evidence ?? "";
    if (detail.length > perOutcome) {
      const truncated = " [output truncated]";
      detail = "";
      if (perOutcome >= truncated.length) {
        detail = result.evidence.slice(0, perOutcome - truncated.length) + truncated;
      }
    }
    return `${headers[index]}${detail ? `\n${detail}` : ""}`;
  }).join("\n");
  let lintVerdicts;
  if (status !== "PASS") {
    lintVerdicts = lintVerdictSummary(applicable, repositoryRoot, exhaustedBudgetMs);
  }
  return {
    status,
    summary,
    evidence,
    ...(lintVerdicts && lintVerdicts.length <= MAX_EVIDENCE ? {
      lintVerdicts,
    } : {}),
    ...(status === "PASS" ? {} : {
      nextCheck,
    }),
  };
}

class LintBudgetExceeded extends Error {}

function captureLintStream(stream, tool, onError) {
  // Always drain the pipe. This ring retains the latest bytes, while the
  // line observer keeps an actual diagnostic even if more noise follows it.
  const tail = Buffer.allocUnsafe(MAX_LINT_STREAM_BYTES);
  let length = 0;
  let offset = 0;
  let truncated = false;
  let finding;
  let eslintPath;
  let eslintDiagnostic;
  let line = "";
  const decoder = new StringDecoder("utf8");
  const recognizeLines = ["eslint", "oxlint", "pyflakes"].includes(tool);

  function observeLines(text, endOfStream = false) {
    let start = 0;
    while (!finding) {
      const newline = text.indexOf("\n", start);
      const end = newline < 0 ? text.length : newline;
      if (line !== undefined && line.length + end - start <= MAX_LINT_STREAM_BYTES) {
        line += text.slice(start, end);
      } else {
        line = undefined;
      }
      if (newline < 0 && !endOfStream) return;

      if (line) {
        const clean = stripVTControlCharacters(line);
        const first = clean.trimStart()[0];
        if (hasTextLintDiagnostic(tool, clean)
          || ((first === "[" || first === "{") && hasLintDiagnostics(tool, clean))) {
          finding = abbreviateLintText(clean.trim(), MAX_FINDING_DISPLAY);
          if (tool === "eslint") {
            eslintDiagnostic = stylishEslintDiagnostic(eslintPath, clean) ?? jsonEslintDiagnostic(clean);
          }
        }
        eslintPath = tool === "eslint" && isAbsolute(clean) ? clean : undefined;
      } else {
        eslintPath = undefined;
      }
      line = "";
      if (newline < 0) return;

      start = newline + 1;
    }
  }

  stream.on("data", chunk => {
    truncated ||= length + chunk.length > MAX_LINT_STREAM_BYTES;
    if (chunk.length >= MAX_LINT_STREAM_BYTES) {
      chunk.copy(tail, 0, chunk.length - MAX_LINT_STREAM_BYTES);
      offset = 0;
      length = MAX_LINT_STREAM_BYTES;
    } else {
      const firstLength = Math.min(chunk.length, MAX_LINT_STREAM_BYTES - offset);
      chunk.copy(tail, offset, 0, firstLength);
      if (firstLength < chunk.length) {
        chunk.copy(tail, 0, firstLength);
      }
      offset = (offset + chunk.length) % MAX_LINT_STREAM_BYTES;
      length = Math.min(length + chunk.length, MAX_LINT_STREAM_BYTES);
    }
    if (recognizeLines && !finding) {
      observeLines(decoder.write(chunk));
    }
  });
  stream.once("error", onError);

  return () => {
    if (recognizeLines && !finding) {
      observeLines(decoder.end(), true);
    }
    let retained = tail.subarray(0, length);
    if (truncated && offset !== 0) {
      retained = Buffer.concat([tail.subarray(offset), tail.subarray(0, offset)], length);
    }
    let start = 0;
    if (truncated) {
      // The first retained byte may be a UTF-8 continuation byte.
      while (start < length && (retained[start] & 0xc0) === 0x80) start += 1;
    }
    const text = retained.toString("utf8", start);
    return {
      text,
      finding,
      eslintDiagnostic,
      truncated,
    };
  };
}

function executeLint(plan, env, deadline, cancellationSignal) {
  cancellationSignal?.throwIfAborted();

  return new Promise(resolve => {
    const grouped = process.platform !== "win32";
    const child = spawn(plan.command[0], plan.command.slice(1), {
      cwd: plan.cwd,
      env,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure;

    const stop = () => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failure ??= error;
      }
    };
    const abort = () => {
      failure ??= cancellationSignal.reason;
      stop();
    };
    const onError = error => {
      failure ??= error;
      stop();
    };
    const isLintProvider = process.argv[1] === lintProviderPath;
    const stopObserving = () => {
      cancellationSignal?.removeEventListener("abort", abort);
      if (isLintProvider) {
        process.off("SIGINT", stopForSignal);
        process.off("SIGTERM", stopForSignal);
      }
    };
    const stopForSignal = signal => {
      stop();
      stopObserving();
      process.kill(process.pid, signal);
    };

    cancellationSignal?.addEventListener("abort", abort, {
      once: true,
    });
    if (isLintProvider) {
      // The provider's lint process group is detached for timeout cleanup,
      // so terminating the provider alone cannot stop its linter.
      process.on("SIGINT", stopForSignal);
      process.on("SIGTERM", stopForSignal);
    }

    const finishStdout = captureLintStream(child.stdout, plan.tool, onError);
    const finishStderr = captureLintStream(child.stderr, plan.tool, onError);
    child.once("error", onError);
    const timer = setTimeout(() => {
      failure ??= new LintBudgetExceeded();
      stop();
    }, Math.max(0, deadline - Date.now()));
    child.once("close", (code, signal) => {
      stopObserving();
      clearTimeout(timer);
      if (Date.now() >= deadline) {
        failure ??= new LintBudgetExceeded();
      }
      if (failure || code !== 0 || signal) {
        stop();
      }
      resolve({
        code,
        signal,
        failure,
        streams: [finishStdout(), finishStderr()],
      });
    });
  });
}

function hasTextLintDiagnostic(tool, text) {
  if (tool === "eslint" || tool === "oxlint") {
    if (/^[ \t]+\d+:\d+[ \t]+(?:error|warning)[ \t]+\S.+$/m.test(text)) return true;
  }
  if (tool === "pyflakes") return /^[^\r\n]+\.pyi?:\d+:\d+: \S.+$/m.test(text);
  return tool === "oxlint"
    && /^[^\r\n]+:\d+:\d+: (?:warning|error) [\w/-]+(?:\([^)]+\))?: \S.+$/m.test(text);
}

function stylishEslintDiagnostic(path, line) {
  if (!path) return;

  // ESLint stylish prints an absolute file header followed by aligned diagnostic columns.
  const match = /^[ \t]+([1-9]\d*):([1-9]\d*)[ \t]{2,}(?:error|warning)[ \t]{2,}(\S.*?)[ \t]{2,}([\w@./-]+)[ \t]*$/.exec(line);
  if (!match) return;

  const [, sourceLine, column, message, rule] = match;
  return {
    path,
    sourceLine,
    column,
    message,
    rule,
  };
}

function parseEslintReport(text) {
  const first = text.trimStart()[0];
  if (first !== "[" && first !== "{") return;

  try {
    const report = JSON.parse(text);
    const results = Array.isArray(report) ? report : report?.results;
    if (Array.isArray(results)) return results;
  } catch {
    // Mixed or clipped tool output is not a complete JSON report.
  }
}

function jsonEslintDiagnostic(text) {
  const results = parseEslintReport(text);
  for (const result of results ?? []) {
    const path = result?.filePath;
    if (typeof path !== "string" || !isAbsolute(path) || !Array.isArray(result.messages)) continue;

    for (const diagnostic of result.messages) {
      if (!isEslintMessage(diagnostic) || !Number.isSafeInteger(diagnostic.line) || diagnostic.line < 1) continue;

      return {
        path,
        sourceLine: diagnostic.line,
        column: Number.isSafeInteger(diagnostic.column) && diagnostic.column > 0 ? diagnostic.column : undefined,
        message: diagnostic.message,
        rule: typeof diagnostic.ruleId === "string" ? diagnostic.ruleId : undefined,
      };
    }
  }
}

function isEslintMessage(message) {
  return (message?.severity === 1 || message?.severity === 2) &&
    typeof message.message === "string" && message.message.length > 0;
}

function eslintDiagnosticForDisplay(streams, repositoryRoot) {
  for (const stream of streams) {
    const diagnostic = stream.eslintDiagnostic ?? jsonEslintDiagnostic(stripVTControlCharacters(stream.text));
    if (!diagnostic) continue;

    const { path, sourceLine, column, message, rule } = diagnostic;
    const relativePath = relative(repositoryRoot, path);
    const displayPath = relativePath.startsWith("../") ? path : relativePath;
    let location = `${displayPath}:${sourceLine}`;
    if (column) {
      location += `:${column}`;
    }
    return {
      location,
      message: abbreviateLintText(message, MAX_FINDING_DISPLAY),
      rule,
    };
  }
}

function hasEslintReport(text) {
  const results = parseEslintReport(text);
  return results?.some(result =>
    typeof result?.filePath === "string" && Array.isArray(result.messages) && result.messages.some(isEslintMessage),
  ) ?? false;
}

function hasLintDiagnostics(tool, output) {
  const text = stripVTControlCharacters(output);
  // A delegated command can fail before the linter starts. Exit 1 alone
  // does not establish that it reported a violation.
  if (hasTextLintDiagnostic(tool, text)) return true;
  if (tool === "eslint") return hasEslintReport(text);
  if (tool !== "oxlint") return false;
  if (hasEslintReport(text)) return true;

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

function abbreviateLintText(text, limit) {
  if (text.length <= limit) return text;

  return `${text.slice(0, limit - 3)}...`;
}

function displayArgument(argument, limit) {
  const sample = abbreviateLintText(argument, limit);
  return abbreviateLintText(JSON.stringify(sample).slice(1, -1), limit);
}

function lintCommandSummary(plan) {
  let command = "";
  let argumentsShown = 0;
  for (const argument of plan.command) {
    const separatorLength = argumentsShown ? 1 : 0;
    if (command.length + argument.length + separatorLength > MAX_LINT_COMMAND_DISPLAY) break;

    const display = displayArgument(argument, MAX_LINT_COMMAND_DISPLAY);
    if (command.length + display.length + separatorLength > MAX_LINT_COMMAND_DISPLAY) break;

    command += `${argumentsShown ? " " : ""}${display}`;
    argumentsShown += 1;
  }
  // The display is a preview, never the argv passed to spawn.
  if (argumentsShown === plan.command.length) {
    return `Inputs (not findings):\nCommand: ${command}`;
  }
  const invocation = plan.command.slice(0, 2).map(argument => displayArgument(argument, 100)).join(" ");
  const sample = plan.paths.slice(0, 2).map(path => displayArgument(path, 80)).join(", ");
  return `Inputs (not findings):\nCommand: ${invocation} (${plan.paths.length} selected paths; sample: ${sample})`;
}

function lintExecutionReason({ code, signal, failure }) {
  if (failure) return abbreviateLintText(String(failure.message), 240);
  if (signal) return `Lint command terminated by ${signal}`;
  if (code === null) return "Lint command ended without an exit status";
  return `Lint command exited with code ${code}`;
}

function lintExecutionEvidence(plan, streams, { completedSuccessfully }) {
  const outputTruncated = streams.some(stream => stream.truncated);
  const output = streams.map(stream => stream.text).filter(Boolean).join("\n");
  const findings = streams.map(stream => stream.finding).filter(Boolean);
  let reportedFindings = findings.length > 0;
  if (!reportedFindings && !completedSuccessfully) {
    // These retained fragments may include complete JSON or multiline reports.
    // Exclude a partial first line so a clipped fragment cannot count as a finding.
    const completeText = streams.map(({ text, truncated }) => {
      if (!truncated) return text;

      const newline = text.indexOf("\n");
      return newline < 0 ? "" : text.slice(newline + 1);
    }).filter(Boolean);
    reportedFindings = completeText.some(text => hasLintDiagnostics(plan.tool, text))
      || (completeText.length > 1 && hasLintDiagnostics(plan.tool, completeText.join("\n")));
  }
  let evidence = output;
  if (outputTruncated) {
    const excerpts = streams.map(stream => stream.text.slice(-MAX_LINT_STREAM_EXCERPT));
    evidence = [
      findings.length > 0 && "Retained diagnostic lines:",
      ...findings,
      lintCommandSummary(plan),
      "Retained lint output:",
      ...excerpts,
    ].filter(Boolean).join("\n");
  } else if (!completedSuccessfully) {
    const retainedFindings = output.length > MAX_LINT_STREAM_EXCERPT * 2 ? findings : [];
    evidence = [
      retainedFindings.length > 0 && "Retained diagnostic lines:",
      ...retainedFindings,
      lintCommandSummary(plan),
      output && `Retained lint output:\n${output}`,
    ].filter(Boolean).join("\n");
  } else if (!output) {
    evidence = lintCommandSummary(plan);
  }
  return {
    outputTruncated,
    reportedFindings,
    evidence: evidence.slice(0, MAX_RESTART_EVIDENCE),
  };
}

async function restartFileIdentity(path) {
  const target = await realpath(path);
  const file = await stat(target, {
    bigint: true,
  });
  return {
    target,
    isFile: file.isFile(),
    generation: `${file.dev}:${file.ino}:${file.mode}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`,
  };
}

async function restartArgumentIdentity(cwd, argument) {
  if (argument === "--") {
    return undefined;
  }

  const equals = argument.indexOf("=");
  let filename = argument;
  if (argument.startsWith("-")) {
    if (equals === -1) {
      return undefined;
    }

    filename = argument.slice(equals + 1);
  }

  try {
    return await restartFileIdentity(resolve(cwd, filename));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return undefined;
    }

    throw error;
  }
}

async function lintRestartKey(plan) {
  if (plan.restartDisabled || plan.restartArguments?.length > MAX_RESTART_ARGUMENTS) {
    return undefined;
  }

  try {
    const launcher = await restartFileIdentity(plan.command[0]);
    if (!launcher.isFile) {
      return undefined;
    }

    let tool = launcher;
    if (plan.executable && plan.executable !== plan.command[0]) {
      tool = await restartFileIdentity(plan.executable);
      if (!tool.isFile) {
        return undefined;
      }
    }

    let configuration;
    if (isAbsolute(plan.configuration)) {
      configuration = await restartFileIdentity(plan.configuration.replace(/:eslintConfig$/, ""));
    }

    const argumentFiles = [];
    for (const argument of plan.restartArguments ?? []) {
      const identity = await restartArgumentIdentity(plan.cwd, argument);
      if (!identity) {
        continue;
      }

      if (!identity.isFile && !inside(plan.repositoryRoot, identity.target)) {
        return undefined;
      }

      argumentFiles.push(identity);
    }

    const identity = JSON.stringify([
      plan.cwd,
      plan.language,
      plan.tool,
      plan.command,
      plan.paths,
      plan.wholeProject,
      launcher,
      tool,
      configuration,
      argumentFiles,
    ]);
    return `project-lint:${createHash("sha256").update(identity).digest("hex")}`;
  } catch {
    return undefined;
  }
}

function passedLintGroup(group, evidence, outputTruncated) {
  return {
    ...group,
    status: "PASS",
    summary: "The existing non-fixing lint command exited 0",
    outputTruncated,
    evidence,
  };
}

function lintGroupNotStarted(group, budgetMs) {
  return {
    ...group,
    status: "BLOCKED",
    execution: "not-started",
    summary: `Lint command never started before the overall time budget (${budgetMs} ms) expired`,
  };
}

export async function verifyProjectLint({
  cwd,
  changedPaths,
  env = process.env,
  budgetMs = DEFAULT_PROJECT_LINT_BUDGET_MS,
  restart = currentVerificationRestart(),
}) {
  validateProjectLintBudget(budgetMs);

  const cancellationSignal = verificationCancellationSignal();
  cancellationSignal?.throwIfAborted();

  const deadline = Date.now() + budgetMs;
  const discovery = await discoverProjectLinters({ cwd, changedPaths, env });
  cancellationSignal?.throwIfAborted();

  const outcomes = [...discovery.results];
  let budgetExhausted = false;
  for (const plan of discovery.plans) {
    cancellationSignal?.throwIfAborted();

    const group = {
      language: plan.language,
      root: plan.root,
      tool: plan.tool,
      wholeProjectTrigger: plan.wholeProjectTrigger,
    };
    if (budgetExhausted || Date.now() >= deadline) {
      budgetExhausted = true;
      outcomes.push(lintGroupNotStarted(group, budgetMs));
      continue;
    }

    try {
      plan.repositoryRoot = discovery.repositoryRoot;
      let restartKey;
      if (restart && Date.now() < deadline) {
        restartKey = await lintRestartKey(plan);
        const previous = restartKey && await restart.read(restartKey);
        cancellationSignal?.throwIfAborted();
        if (previous?.status === "PASS"
          && typeof previous.evidence === "string"
          && previous.evidence.length <= MAX_RESTART_EVIDENCE
          && Date.now() < deadline) {
          outcomes.push({
            ...passedLintGroup(group, previous.evidence, previous.outputTruncated === true),
            execution: "restored",
          });
          continue;
        }
      }

      const applicable = await inspectEslint(plan);
      cancellationSignal?.throwIfAborted();

      if (plan.inspectEslint && applicable.length === 0) {
        outcomes.push({
          ...group,
          status: "N/A",
          summary: "Changed source is outside the configured ESLint scope",
        });
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        budgetExhausted = true;
        outcomes.push(lintGroupNotStarted(group, budgetMs));
        continue;
      }

      const execution = await executeLint(plan, env, deadline, cancellationSignal);
      cancellationSignal?.throwIfAborted();

      const { code, signal, failure, streams } = execution;
      const completedSuccessfully = !failure && !signal && code === 0;
      const { evidence, outputTruncated, reportedFindings } = lintExecutionEvidence(plan, streams, {
        completedSuccessfully,
      });
      if (completedSuccessfully) {
        outcomes.push(passedLintGroup(group, evidence, outputTruncated));
        if (restartKey && await lintRestartKey(plan) === restartKey) {
          cancellationSignal?.throwIfAborted();

          await restart.save(restartKey, {
            status: "PASS",
            evidence,
            outputTruncated,
          });
        }
        continue;
      }

      if (failure instanceof LintBudgetExceeded) {
        budgetExhausted = true;

        let summary = `Lint command interrupted after exceeding the overall time budget (${budgetMs} ms)`;
        if (reportedFindings) {
          summary += `; ${plan.tool} reported findings before interruption`;
        }
        outcomes.push({
          ...group,
          status: "BLOCKED",
          execution: "interrupted",
          summary,
          evidence,
          outputTruncated,
          reportedFindings,
        });
        continue;
      }

      const completedWithExit = !failure && !signal && code !== null;
      const unprovenFailure = completedWithExit && plan.requiresDiagnostics && !reportedFindings;
      const status = completedWithExit && code === 1 && !unprovenFailure ? "FAIL" : "BLOCKED";
      const summary = status === "FAIL"
        ? `${plan.tool} reported lint violations`
        : unprovenFailure
          ? `The declared command failed without recognized ${plan.tool} diagnostics; lint execution is unverified`
          : `${plan.tool} could not complete`;
      let diagnostic;
      if (status === "FAIL" && plan.tool === "eslint") {
        diagnostic = eslintDiagnosticForDisplay(streams, discovery.repositoryRoot);
      }
      outcomes.push({
        ...group,
        status,
        summary,
        executionReason: lintExecutionReason(execution),
        diagnostic,
        diagnosticsObserved: reportedFindings,
        outputTruncated,
        evidence,
      });
    } catch (error) {
      cancellationSignal?.throwIfAborted();

      outcomes.push({
        ...group,
        status: "BLOCKED",
        summary: `${plan.tool} could not complete`,
        executionReason: abbreviateLintText(String(error.message), 240),
        evidence: lintCommandSummary(plan),
      });
    }
  }
  cancellationSignal?.throwIfAborted();

  if (budgetExhausted) {
    const result = combinedResult(outcomes, discovery.repositoryRoot, budgetMs);
    result.lintBudgetExhaustedMs = budgetMs;
    return markVerificationTimeout(result);
  }
  return combinedResult(outcomes, discovery.repositoryRoot);
}
