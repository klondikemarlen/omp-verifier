import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { LINTER_CATALOG } from "#root/omp-plugin/lint-catalog.js";
import { assertPrLintDefaults, changedLintPaths, prLintInvocation, prLintSourceArgument } from "#root/omp-plugin/project-lint-pr.js";
import { changedProjectPaths } from "#root/omp-plugin/verifications.js";

const execFileAsync = promisify(execFile);

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

export function insideLintCheckout(root, path) {
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
  while (insideLintCheckout(root, directory)) {
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
    if (!insideLintCheckout(repositoryRoot, await realpath(absolute))) throw new Error(`Source resolves outside the owning checkout: ${path}`);
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
  const { family, root, prScoped, wholeProjectTrigger } = group;
  let { paths } = group;
  if (prScoped && family.id === "go") {
    return { result: blocked(family.id, root, "Go lint cannot be confined to PR files", "The supported Go linter runs package-level analysis. Run the documented Go lint command explicitly to check that wider scope.") };
  }
  const wholeProject = wholeProjectTrigger !== undefined;
  const supportedTools = family.tools.map(tool => tool.id).join(", ");
  const binding = await projectBinding(root, repositoryRoot, family);
  if (binding) {
    const { tool, command, appendPaths } = binding.binding ?? {};
    if (!family.tools.some(candidate => candidate.id === tool) || !Array.isArray(command) || command.length === 0 || unsafeLintArguments(tool, command) || (appendPaths !== undefined && typeof appendPaths !== "boolean")) {
      return { result: blocked(family.id, root, `Invalid or fixing lint.commands.${family.id} binding`, `Supported tools: ${supportedTools}. Declare the actual tool and a non-fixing command argv array; appendPaths, when present, must be boolean; shell evaluation and installers are not supported.`) };
    }
    let scopedArguments;
    if (prScoped) {
      if (!appendPaths) {
        return { result: blocked(family.id, root, "The fixed lint binding cannot be scoped to PR files", `Use appendPaths: true with a direct ${tool} command and no fixed source targets, or run the existing binding explicitly.`) };
      }
      scopedArguments = prLintInvocation(tool, command).args;
    }
    const program = await executable(command[0], binding.directory, repositoryRoot, env);
    if (!program) return { result: blocked(family.id, root, "The declared project lint command is unavailable", command[0]) };
    const sourceArguments = appendPaths ? paths.map(path => {
      const argument = relative(binding.directory, join(repositoryRoot, path));
      if (prScoped) return prLintSourceArgument(argument);
      return argument.startsWith("-") ? `./${argument}` : argument;
    }) : [];
    const restartArguments = scopedArguments ?? command.slice(1);
    return {
      plan: {
        language: family.id,
        tool,
        cwd: binding.directory,
        command: [program, ...restartArguments, ...sourceArguments],
        paths,
        wholeProject,
        prScoped,
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
    if (prScoped) {
      return { result: blocked(family.id, root, "The execution wrapper runs a package lint script that cannot be scoped to PR files", "Run the documented wrapper explicitly for its package scope. Automatic PR lint will not invoke npm scripts or bypass the declared wrapper.") };
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
  if (!tool || (!configurations.length && !(prScoped && script) && !["shellcheck", "pyflakes", "oxlint"].includes(tool))) {
    return { result: blocked(family.id, root, "No supported project lint configuration was found", `Expected existing configuration for ${supportedTools} in ${family.label}, or an explicit supported project command. A tool on PATH alone does not select it. No tools or configuration were installed.`) };
  }

  const [scriptBinary, ...scriptArguments] = script?.value.trim().split(/\s+/) ?? [];
  let scopedInvocation;
  if (prScoped) {
    if (script && (Object.hasOwn(pkg.scripts, `pre${script.name}`) || Object.hasOwn(pkg.scripts, `post${script.name}`))) {
      return { result: blocked(family.id, root, "The package lint script has lifecycle hooks", `Run ${script.name} explicitly for its declared lifecycle. Automatic PR lint cannot prove those hooks stay within its changed files.`) };
    }
    const args = script ? scriptArguments : nativeArguments(tool, []);
    scopedInvocation = prLintInvocation(tool, [scriptBinary ?? tool, ...args], { allowSelectors: Boolean(script) });
    if (scopedInvocation.selectors.length && !scopedInvocation.selectors.includes("")) {
      paths = paths.filter(path => {
        const source = relative(root, join(repositoryRoot, path));
        return scopedInvocation.selectors.some(selector => source === selector || source.startsWith(`${selector}/`));
      });
      if (!paths.length) return {};
    }
  }
  let program = await executable(scriptBinary ?? tool, root, repositoryRoot, env);
  let prefix = [];
  if (tool === "rubocop" && await fileExists(join(root, "Gemfile"))) {
    program = await executable("bundle", root, repositoryRoot, env);
    prefix = ["exec", "rubocop"];
  }
  if (!program) return { result: blocked(family.id, root, "The configured linter is unavailable", `${tool} could not be found in the project, its installed environment, or PATH. Restore the existing project setup; Verifier does not provision tools.`) };

  const sourcePaths = paths.map(path => relative(root, join(repositoryRoot, path)));
  const args = prScoped
    ? [...scopedInvocation.args, ...sourcePaths.map(prLintSourceArgument)]
    : nativeArguments(tool, sourcePaths);
  let command = [program, ...prefix, ...args];
  let restartDisabled = prefix.length > 0;
  if (script && !prScoped) {
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
      inspectEslint: scopedInvocation?.inspectEslint ?? tool === "eslint",
      requiresDiagnostics: ["oxlint", "pyflakes"].includes(tool),
      executable: program,
      prScoped,
      restartArguments: scopedInvocation?.args,
      restartDisabled,
    },
  };
}

export async function discoverProjectLinters({ cwd, changedPaths, prScope, env = process.env }) {
  let repositoryRoot = resolve(cwd);
  const plans = [];
  const results = [];
  const prScoped = prScope !== undefined;
  try {
    const root = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000, maxBuffer: 16_000 });
    repositoryRoot = await realpath(root.stdout.trim());
    if (prScoped) {
      changedPaths = changedLintPaths(prScope, changedPaths);
    } else if (changedPaths === undefined) {
      const changeSet = await changedProjectPaths(cwd);
      if (changeSet.error) throw new Error(changeSet.error);
      changedPaths = changeSet.paths;
    }
    if (!Array.isArray(changedPaths) || changedPaths.some(path => typeof path !== "string")) throw new Error("Changed paths must be a project-relative string array");
    const groups = new Map();
    for (const raw of new Set(changedPaths)) {
      const path = raw.replaceAll("\\", "/").replace(/^\.\//, "");
      if (prScoped && (path !== raw || raw.includes("\\") || raw.includes("\0") || raw.split("/").some(part => !part || part === "."))) {
        throw new Error(`PR lint cannot safely address changed path ${JSON.stringify(raw)}`);
      }
      if (!path || isAbsolute(path) || path.split("/").includes("..")) throw new Error(`Changed path is outside the owning checkout: ${path}`);
      const absolute = resolve(repositoryRoot, path);
      if (!insideLintCheckout(repositoryRoot, absolute)) throw new Error(`Changed path is outside the owning checkout: ${path}`);
      const name = path.split("/").at(-1);
      const candidates = LINTER_CATALOG.filter(family =>
        family.sources.includes(extname(path)) || projectMarkers(family).includes(name) || name === ".omp-verifier.json");
      if (candidates.length === 0) continue;
      if (prScoped && (name === ".omp-verifier.json" || name.startsWith("eslint.config.")
        || candidates.some(family => projectMarkers(family).includes(name)))) continue;
      if (!await fileExists(absolute)) continue;
      const target = await realpath(absolute);
      if (!insideLintCheckout(repositoryRoot, target)) throw new Error(`Changed source resolves outside the owning checkout: ${path}`);
      if (prScoped && absolute !== target) throw new Error(`Changed lint source is a symbolic link or uses a symbolic-link directory: ${path}`);
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
            prScoped,
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
          if (prScoped) await assertPrLintDefaults(discovered.plan, repositoryRoot, env);
          plans.push({
            ...discovered.plan,
            root,
            wholeProjectTrigger,
          });
        } else if (discovered.result) {
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
          ...(prScoped ? { executionReason: error.message.slice(0, 320) } : {}),
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

