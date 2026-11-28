import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// Only options with known arity and no ability to initiate another lint scope belong here.
const PR_LINT_OPTIONS = {
  eslint: {
    switches: ["--no-fix", "--quiet", "--no-ignore", "--no-config-lookup", "--no-inline-config", "--report-unused-disable-directives", "--color", "--no-color"],
    values: ["--max-warnings", "--config", "-c", "--ignore-pattern", "--ignore-path", "--ext", "--rule", "--format", "-f", "--report-unused-disable-directives-severity"],
  },
  oxlint: {
    switches: ["--deny-warnings", "--quiet", "--no-ignore", "--no-eslintrc"],
    values: ["--max-warnings", "--config", "-c", "--ignore-path", "--ignore-pattern", "--format", "-f", "--allow", "-A", "--warn", "-W", "--deny", "-D"],
  },
  ruff: {
    switches: ["--no-fix", "--force-exclude", "--isolated", "--no-cache", "--quiet", "-q", "--respect-gitignore", "--no-respect-gitignore"],
    values: ["--config", "--select", "--extend-select", "--ignore", "--extend-ignore", "--per-file-ignores", "--extend-per-file-ignores", "--exclude", "--extend-exclude", "--target-version", "--output-format"],
  },
  pyflakes: { switches: [], values: [] },
  rubocop: {
    switches: ["--force-exclusion", "--display-cop-names", "--no-color", "--color"],
    values: ["--config", "-c", "--only", "--except", "--format", "-f", "--fail-level"],
  },
  shellcheck: {
    switches: ["--norc"],
    values: ["--severity", "-S", "--shell", "-s", "--format", "-f", "--exclude", "-e", "--include", "-i", "--source-path", "-P"],
  },
};

export function changedLintPaths(prScope, changedPaths) {
  if (prScope?.version !== 1 || !Array.isArray(changedPaths)
    || changedPaths.some(path => typeof path !== "string")
    || !Array.isArray(prScope.wholeFilePaths) || !Array.isArray(prScope.deletedPaths)
    || !prScope.lineRanges || typeof prScope.lineRanges !== "object" || Array.isArray(prScope.lineRanges)) {
    throw new Error("PR lint needs the matching delivery paths and version 1 PR scope; capture verification again against the actual base");
  }

  const eligible = new Set([...Object.keys(prScope.lineRanges), ...prScope.wholeFilePaths]);
  for (const path of prScope.deletedPaths) eligible.delete(path);
  return changedPaths.filter(path => eligible.has(path));
}

function hasPattern(path) {
  return /[\\*?[\]{}]/.test(path) || /[+@!]\(/.test(path) || path.startsWith("!");
}

export function prLintSourceArgument(path) {
  if (hasPattern(path)) {
    throw new Error(`Cannot safely pass a changed lint filename containing a glob metacharacter (${JSON.stringify(path)}); verify that file explicitly with the project's linter`);
  }
  return /^[-@]/.test(path) ? `./${path}` : path;
}

function lintSelector(argument) {
  if (hasPattern(argument) || isAbsolute(argument) || argument === "-" || /^[@~]/.test(argument)) return undefined;

  const parts = argument.split("/").filter(part => part && part !== ".");
  if (parts.includes("..")) return undefined;
  return parts.join("/");
}

function lintOptions(tool, args, { allowSelectors }) {
  const options = PR_LINT_OPTIONS[tool];
  const flags = [];
  const selectors = [];
  let afterDelimiter = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!afterDelimiter && argument === "--") {
      afterDelimiter = true;
      continue;
    }
    if (!afterDelimiter && argument.startsWith("-")) {
      const equals = argument.indexOf("=");
      const hasInlineValue = equals !== -1;
      const option = hasInlineValue ? argument.slice(0, equals) : argument;
      if (!hasInlineValue && options.switches.includes(option)) {
        flags.push(argument);
        continue;
      }
      if (options.values.includes(option)) {
        const separateValue = args[index + 1];
        if (!hasInlineValue && (!separateValue || separateValue.startsWith("-"))) {
          throw new Error(`Cannot identify the value for lint option ${option}; use ${option}=value in the declared argv`);
        }
        flags.push(argument);
        if (!hasInlineValue) flags.push(args[++index]);
        continue;
      }
      throw new Error(`Lint option ${option} has no established changed-file behavior; run the documented command explicitly`);
    }

    const selector = allowSelectors ? lintSelector(argument) : undefined;
    if (selector === undefined) {
      throw new Error(`Cannot safely narrow lint target ${JSON.stringify(argument)}; use a literal project-relative file or directory in the package script, or run the command explicitly`);
    }
    selectors.push(selector);
  }
  return { flags, selectors };
}

function lintToolPrefix(tool, binary, args) {
  const basename = binary.split(/[\\/]/).at(-1);
  if (tool === "rubocop" && basename === "bundle" && args[0] === "exec" && args[1] === "rubocop") return ["exec", "rubocop"];
  if (tool === "pyflakes" && ["python", "python3"].includes(basename) && args[0] === "-m" && args[1] === "pyflakes") return ["-m", "pyflakes"];
  if (basename !== tool && !(tool === "pyflakes" && basename === "pyflakes3")) {
    throw new Error(`Cannot constrain opaque ${tool} command ${JSON.stringify(binary)} to PR files, even with appendPaths; run the documented wrapper explicitly`);
  }
  return tool === "ruff" ? ["check"] : [];
}

export function prLintInvocation(tool, [binary, ...args], { allowSelectors = false } = {}) {
  const prefix = lintToolPrefix(tool, binary, args);
  if (prefix.some((argument, index) => argument !== args[index])) {
    throw new Error(`Expected ${tool} ${prefix.join(" ")} for a changed-file lint invocation`);
  }
  const { flags, selectors } = lintOptions(tool, args.slice(prefix.length), { allowSelectors });
  const inspectEslint = tool === "eslint" && flags.every(argument => !/^(-c|--config|--no-config-lookup|--no-ignore|--ignore-pattern|--ignore-path|--ext|--rule)(=|$)/.test(argument));
  if (tool === "eslint" && !flags.includes("--no-fix")) flags.push("--no-fix");
  if (tool === "ruff") {
    if (!flags.includes("--no-fix")) flags.push("--no-fix");
    if (!flags.includes("--force-exclude")) flags.push("--force-exclude");
  }
  if (tool === "rubocop" && !flags.includes("--force-exclusion")) flags.push("--force-exclusion");
  if (tool !== "pyflakes") flags.push("--");
  return { args: [...prefix, ...flags], selectors, inspectEslint };
}

async function readLintConfig(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return "";
    throw error;
  }
}

function shellcheckConfigPaths(paths, repositoryRoot, env) {
  const directories = new Set();
  for (const source of paths) {
    let directory = dirname(join(repositoryRoot, source));
    while (!directories.has(directory)) {
      directories.add(directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const home = env.HOME || homedir();
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config");
  const userConfig = process.platform === "win32" ? join(env.APPDATA || home, "shellcheckrc") : join(home, ".shellcheckrc");
  return [
    ...Array.from(directories).flatMap(directory => [".shellcheckrc", "shellcheckrc", ".editorconfig"].map(name => join(directory, name))),
    userConfig,
    join(xdgConfig, "shellcheckrc"),
    join(xdgConfig, "editorconfig.ini"),
  ];
}

export async function assertPrLintDefaults(plan, repositoryRoot, env) {
  if (plan.tool === "rubocop" && (env.RUBOCOP_OPTS?.trim() || (await readLintConfig(join(plan.cwd, ".rubocop"))).trim())) {
    throw new Error("RuboCop adds opaque argv from RUBOCOP_OPTS or .rubocop. Declare safe flags in the lint binding instead, or run the documented command explicitly.");
  }
  if (plan.tool !== "shellcheck") return;

  // ShellCheck prepends these arguments, including any files or --files-from options.
  if (env.SHELLCHECK_OPTS) {
    throw new Error("SHELLCHECK_OPTS adds opaque argv. Declare safe flags in the lint binding instead, or run the documented command explicitly.");
  }
  if (plan.command.includes("--norc")) return;

  // ShellCheck can opt into following additional source files via its rc files.
  const externalSources = /^[ \t]*[^#;\r\n]*?(?:\b|^)(?:shellcheck\.)?external-sources[ \t]*[:=][ \t]*["']?true\b/im;
  for (const path of shellcheckConfigPaths(plan.paths, repositoryRoot, env)) {
    if (externalSources.test(await readLintConfig(path))) {
      throw new Error(`${path} enables ShellCheck external sources. Run the documented lint command explicitly for analysis beyond PR files.`);
    }
  }
}
