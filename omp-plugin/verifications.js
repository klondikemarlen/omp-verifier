import { access, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64_000;
const MAX_FIELD_LENGTH = 4_000;
const CHECK_ID = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const NODE_RUNTIME = "node";
const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SUPPRESSION_FILE = ".omp-verifier.json";

function defaultPackageDirectory() {
  const parent = dirname(packageRoot);
  if (basename(parent) === "node_modules") return parent;
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
  return join(dirname(agentDir), "plugins", "node_modules");
}

function blocked(id, summary, evidence) {
  return { id, status: "BLOCKED", summary, ...(evidence ? { evidence } : {}) };
}

function validString(value, name, required = true) {
  if (typeof value !== "string" || (required && !value.trim()) || value.length > MAX_FIELD_LENGTH) {
    throw new Error(`${name} must be a ${required ? "non-empty " : ""}string no longer than ${MAX_FIELD_LENGTH} characters`);
  }
  return value;
}

function projectPath(value, name) {
  const path = validString(value, name).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path === "." || isAbsolute(path) || path.split("/").includes("..")) {
    throw new Error(`${name} must be a project-relative path without traversal`);
  }
  return path;
}

function globPattern(value, name, { bounded = false } = {}) {
  const pattern = projectPath(value, name);
  if (bounded && (pattern === "**" || pattern === "**/*")) {
    throw new Error(`${name} must not match the entire project`);
  }
  return pattern;
}

function matchesGlob(path, pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += "\\^$+?.()|{}[]".includes(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

function verificationPathTriggers(entry) {
  if (entry.pathTriggers === undefined) return undefined;
  if (!Array.isArray(entry.pathTriggers) || entry.pathTriggers.length === 0) {
    throw new Error("pathTriggers must be a non-empty array");
  }
  return entry.pathTriggers.map((trigger, index) => globPattern(trigger, `pathTriggers[${index}]`));
}

function suppressionResultId(configPath, root) {
  return `suppression:${relative(root, configPath) || SUPPRESSION_FILE}`;
}

function validExpiry(value) {
  if (value === undefined) return undefined;
  const expiry = validString(value, "expires");
  const date = new Date(`${expiry}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== expiry) {
    throw new Error("expires must use a valid YYYY-MM-DD date");
  }
  if (expiry < new Date().toISOString().slice(0, 10)) throw new Error(`suppression expired on ${expiry}`);
  return expiry;
}

function manifestSuppression(entry, configDirectory) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("suppression entry must be an object");
  const id = validString(entry.id, "suppression id");
  if (!CHECK_ID.test(id)) throw new Error("suppression id must use namespace:name lowercase identifiers");
  return {
    id,
    path: globPattern(entry.path, "suppression path", { bounded: true }),
    reason: validString(entry.reason, "suppression reason"),
    expires: validExpiry(entry.expires),
    configDirectory,
  };
}

async function discoverSuppressions(root, changedPaths) {
  const directories = new Set([root]);
  for (const changedPath of changedPaths) {
    let directory = dirname(changedPath);
    while (directory !== ".") {
      directories.add(resolve(root, directory));
      directory = dirname(directory);
    }
  }

  const suppressions = [];
  const blockedResults = [];
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    const configPath = join(directory, SUPPRESSION_FILE);
    let config;
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      blockedResults.push(blocked(suppressionResultId(configPath, root), "Invalid verification suppression configuration", error.message));
      continue;
    }

    if (!config || typeof config !== "object" || Array.isArray(config) || !Array.isArray(config.suppressions)) {
      blockedResults.push(blocked(suppressionResultId(configPath, root), "Invalid verification suppression configuration", "suppressions must be an array"));
      continue;
    }

    for (const entry of config.suppressions) {
      try {
        suppressions.push(manifestSuppression(entry, directory));
      } catch (error) {
        const id = typeof entry?.id === "string" ? entry.id : suppressionResultId(configPath, root);
        blockedResults.push(blocked(id, "Invalid verification suppression configuration", error.message));
      }
    }
  }
  return { suppressions, blockedResults };
}

function suppressionFor(checkId, root, changedPath, suppressions) {
  return suppressions.find(suppression => {
    if (suppression.id !== checkId) return false;
    const scopedPath = relative(suppression.configDirectory, resolve(root, changedPath));
    if (!scopedPath || scopedPath.startsWith("..") || isAbsolute(scopedPath)) return false;
    return matchesGlob(scopedPath.replaceAll("\\", "/"), suppression.path);
  });
}

async function registeredPluginDirectories(packageDirectory) {
  const registryPath = join(dirname(packageDirectory), "package.json");
  let registry;
  try {
    const registryContents = await readFile(registryPath, "utf8");
    registry = JSON.parse(registryContents);
  } catch {
    return undefined;
  }

  if (!registry) return undefined;
  if (typeof registry !== "object") return undefined;
  if (Array.isArray(registry)) return undefined;
  if (registry.name !== "omp-plugins") return undefined;

  const dependencies = registry.dependencies;
  if (!dependencies) return undefined;
  if (typeof dependencies !== "object") return undefined;
  if (Array.isArray(dependencies)) return undefined;

  return Object.keys(dependencies).map(name => join(packageDirectory, name));
}

async function packageDirectories(packageDirectory) {
  const registeredDirectories = await registeredPluginDirectories(packageDirectory);
  if (registeredDirectories) return { directories: registeredDirectories, errors: [] };
  const directories = [];
  const errors = [];
  let entries;
  try {
    entries = await readdir(packageDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { directories, errors };
    return { directories, errors: [{ path: packageDirectory, error }] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      const scopedDirectory = join(packageDirectory, entry.name);
      try {
        const scopedEntries = await readdir(scopedDirectory, { withFileTypes: true });
        directories.push(...scopedEntries.filter(item => item.isDirectory()).map(item => join(scopedDirectory, item.name)));
      } catch (error) {
        errors.push({ path: scopedDirectory, error });
      }
    } else {
      directories.push(join(packageDirectory, entry.name));
    }
  }
  return { directories, errors };
}

async function manifestCheck(packageName, packagePath, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("verification entry must be an object");

  const id = validString(entry.id, "id");
  if (!CHECK_ID.test(id)) throw new Error("id must use namespace:name lowercase identifiers");
  const label = validString(entry.label, "label");
  const description = validString(entry.description, "description");
  const moduleEntry = validString(entry.entry, "entry");
  if (
    !moduleEntry.startsWith("./") ||
    extname(moduleEntry) !== ".mjs" ||
    isAbsolute(moduleEntry) ||
    moduleEntry.split(/[\\/]/).includes("..")
  ) {
    throw new Error("entry must be a package-relative .mjs module without traversal");
  }

  const entryPath = resolve(packagePath, moduleEntry);
  if (relative(packagePath, entryPath).startsWith("..")) throw new Error("entry must stay inside its package");
  try {
    const [packageRealPath, entryRealPath] = await Promise.all([realpath(packagePath), realpath(entryPath)]);
    const realEntryRelativePath = relative(packageRealPath, entryRealPath);
    if (realEntryRelativePath.startsWith("..") || isAbsolute(realEntryRelativePath)) {
      throw new Error("entry must stay inside its package");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const timeoutMs = entry.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : entry.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }

  return { id, label, description, entryPath, packageName, pathTriggers: verificationPathTriggers(entry), timeoutMs };
}

export async function discoverVerificationChecks({ packageDirectory = defaultPackageDirectory() } = {}) {
  const checks = [];
  const blockedResults = [];
  const seen = new Map();
  const duplicateIds = new Set();

  const { directories, errors } = await packageDirectories(packageDirectory);
  for (const { path, error } of errors) {
    blockedResults.push(blocked(`manifest:${path}`, "Could not inspect plugin directory", error.message));
  }

  for (const directory of directories) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      blockedResults.push(blocked(`manifest:${directory}`, "Could not read plugin manifest", error.message));
      continue;
    }

    const extensionEntries = [
      ...(Array.isArray(manifest?.omp?.extensions) ? manifest.omp.extensions : []),
      ...(Array.isArray(manifest?.pi?.extensions) ? manifest.pi.extensions : []),
    ];
    if (extensionEntries.length === 0) continue;
    if (manifest?.omp?.verifications === undefined) continue;

    const packageName = typeof manifest.name === "string" && manifest.name ? manifest.name : directory;
    if (!Array.isArray(manifest.omp.verifications)) {
      blockedResults.push(blocked(`manifest:${packageName}`, "Plugin verifications must be an array"));
      continue;
    }

    for (const entry of manifest.omp.verifications) {
      let check;
      try {
        check = await manifestCheck(packageName, directory, entry);
      } catch (error) {
        const id = typeof entry?.id === "string" ? entry.id : `manifest:${packageName}`;
        blockedResults.push(blocked(id, "Invalid plugin verification manifest", error.message));
        continue;
      }

      if (duplicateIds.has(check.id)) {
        blockedResults.push(blocked(check.id, "Duplicate plugin verification id", `${check.packageName} declares ${check.id} again`));
        continue;
      }
      if (seen.has(check.id)) {
        const original = seen.get(check.id);
        const duplicateEvidence = `${original.packageName} and ${check.packageName} declare ${check.id}`;
        const index = checks.findIndex(candidate => candidate.id === check.id);
        if (index !== -1) {
          checks.splice(index, 1);
          blockedResults.push(blocked(check.id, "Duplicate plugin verification id", `${original.packageName} declared ${check.id}`));
        }
        blockedResults.push(blocked(check.id, "Duplicate plugin verification id", duplicateEvidence));
        seen.delete(check.id);
        duplicateIds.add(check.id);
        continue;
      }

      seen.set(check.id, check);
      checks.push(check);
    }
  }

  return { checks, blockedResults };
}

function resultFromOutput(check, output) {
  if (output.length > MAX_OUTPUT_BYTES) return blocked(check.id, "Verification output exceeded the limit");

  let result;
  try {
    result = JSON.parse(output);
  } catch {
    return blocked(check.id, "Verification did not return one JSON result");
  }

  try {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("result must be an object");
    if (!STATUSES.has(result.status)) throw new Error("status must be PASS, FAIL, or BLOCKED");
    const summary = validString(result.summary, "summary");
    const evidence = result.evidence === undefined ? undefined : validString(result.evidence, "evidence", false);
    const nextCheck = result.nextCheck === undefined ? undefined : validString(result.nextCheck, "nextCheck", false);
    return { id: check.id, status: result.status, summary, ...(evidence ? { evidence } : {}), ...(nextCheck ? { nextCheck } : {}) };
  } catch (error) {
    return blocked(check.id, "Verification returned an invalid result", error.message);
  }
}

function verificationEnvironment(changedPaths) {
  const { OMP_VERIFIER_CHANGED_PATHS: _automaticPaths, ...environment } = process.env;
  return changedPaths ? { ...environment, OMP_VERIFIER_CHANGED_PATHS: JSON.stringify(changedPaths) } : environment;
}

export async function runVerificationCheck(check, cwd, changedPaths) {
  try {
    await access(check.entryPath);
    const { stdout, stderr } = await execFileAsync(NODE_RUNTIME, [check.entryPath], {
      cwd,
      env: verificationEnvironment(changedPaths),
      timeout: check.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (stderr) return blocked(check.id, "Verification wrote to stderr", stderr.slice(0, MAX_FIELD_LENGTH));
    return resultFromOutput(check, stdout.trim());
  } catch (error) {
    if (typeof error?.code === "number" && !error.stderr) {
      const result = resultFromOutput(check, String(error.stdout || "").trim());
      if (result.status === "FAIL") return result;
    }
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return blocked(check.id, "Verification output exceeded the limit");
    if (error?.killed || error?.signal === "SIGTERM") return blocked(check.id, "Verification timed out");
    if (typeof error?.code === "number") return blocked(check.id, `Verification exited with code ${error.code}`, String(error.stderr || error.stdout || "").slice(0, MAX_FIELD_LENGTH));
    return blocked(check.id, "Verification could not run", error.message);
  }
}

export async function runVerificationChecks(checks, cwd, ids = []) {
  const byId = new Map(checks.map(check => [check.id, check]));
  const requestedIds = [...new Set(ids)];
  const selected = requestedIds.length === 0 ? checks : requestedIds.map(id => byId.get(id)).filter(Boolean);
  const unknown = requestedIds.filter(id => !byId.has(id)).map(id => blocked(id, "Verification check is not installed"));
  return [...unknown, ...(await Promise.all(selected.map(check => runVerificationCheck(check, cwd))))];
}

export function selectAutomaticVerificationChecks(checks, changedPaths) {
  return checks.flatMap(check => {
    if (!check.pathTriggers) return [];
    const matches = changedPaths.flatMap(path => {
      const trigger = check.pathTriggers.find(pattern => matchesGlob(path, pattern));
      return trigger ? [{ path, trigger }] : [];
    });
    return matches.length === 0 ? [] : [{ check, matches }];
  });
}

export async function runAutomaticVerification({ cwd, changedPaths, packageDirectory, repositoryRoot = cwd }) {
  let paths;
  try {
    paths = [...new Set(changedPaths.map(path => projectPath(path, "changed path")))];
  } catch (error) {
    return [blocked("verifier:auto-selection", "Could not select verification checks", error.message)];
  }

  const { checks, blockedResults } = await discoverVerificationChecks({ packageDirectory });
  const { suppressions, blockedResults: suppressionBlocks } = await discoverSuppressions(repositoryRoot, paths);
  const installedIds = new Set(checks.map(check => check.id));
  const unknownSuppressionBlocks = suppressions
    .filter(suppression => !installedIds.has(suppression.id))
    .map(suppression => blocked(suppression.id, "Invalid verification suppression configuration", "suppression id is not installed"));
  const selectedChecks = selectAutomaticVerificationChecks(checks, paths);
  if (selectedChecks.length === 0) return [...blockedResults, ...suppressionBlocks, ...unknownSuppressionBlocks];
  const results = [...blockedResults, ...suppressionBlocks, ...unknownSuppressionBlocks];
  for (const { check, matches } of selectedChecks) {
    const unsuppressedMatches = [];
    for (const match of matches) {
      const suppression = suppressionFor(check.id, repositoryRoot, match.path, suppressions);
      if (!suppression) {
        unsuppressedMatches.push(match);
        continue;
      }
      results.push({
        id: check.id,
        status: "SUPPRESSED",
        summary: "Automatic verification suppressed",
        evidence: `${match.path} matched ${suppression.path}: ${suppression.reason}`,
        matches: [match],
      });
    }
    if (unsuppressedMatches.length === 0) continue;
    results.push({ ...(await runVerificationCheck(check, cwd, unsuppressedMatches.map(match => match.path))), matches: unsuppressedMatches });
  }
  return results;
}

export async function runAutomaticVerificationForPaths({ cwd, changedPaths, packageDirectory }) {
  const root = await projectRepositoryRoot(cwd);
  if (root.error) {
    const { checks } = await discoverVerificationChecks({ packageDirectory });
    if (!checks.some(check => check.pathTriggers)) return [];
    return [blocked("verifier:auto-selection", "Could not inspect changed paths", root.error)];
  }
  return runAutomaticVerification({
    cwd,
    changedPaths,
    packageDirectory,
    repositoryRoot: root.repositoryRoot,
  });
}

export async function runCurrentAutomaticVerification({ cwd, packageDirectory }) {
  const changeSet = await changedProjectPaths(cwd);
  if (changeSet.error) {
    const { checks } = await discoverVerificationChecks({ packageDirectory });
    if (!checks.some(check => check.pathTriggers)) return [];
    return [blocked("verifier:auto-selection", "Could not inspect changed paths", changeSet.error)];
  }
  if (changeSet.paths.length === 0) return [];

  return runAutomaticVerification({
    cwd,
    changedPaths: changeSet.paths,
    packageDirectory,
    repositoryRoot: changeSet.repositoryRoot,
  });
}

async function projectRepositoryRoot(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { repositoryRoot: stdout.trim() };
  } catch (error) {
    return { error: error.message };
  }
}

export async function changedProjectPaths(cwd) {
  const root = await projectRepositoryRoot(cwd);
  if (root.error) return root;
  try {
    const { stdout } = await execFileAsync("git", ["-C", root.repositoryRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const entries = stdout.split("\0");
    const paths = new Set();
    for (let index = 0; index < entries.length - 1; index += 1) {
      const entry = entries[index];
      const status = entry.slice(0, 2);
      paths.add(entry.slice(3));
      if (status.includes("R") || status.includes("C")) paths.add(entries[++index]);
    }
    return { repositoryRoot: root.repositoryRoot, paths: [...paths].filter(Boolean) };
  } catch (error) {
    return { error: error.message };
  }
}
