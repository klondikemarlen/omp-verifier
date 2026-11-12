import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSemanticContract } from "#root/omp-plugin/semantic-contracts.js";
import { planAutomaticVerification } from "#root/omp-plugin/automatic-selection.js";

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FIELD_LENGTH = 4_000;
const CHECK_ID = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
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

export function projectPath(value, name) {
  const path = validString(value, name).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path === "." || isAbsolute(path) || path.startsWith("//") || /^[a-zA-Z]:/.test(path) || path.split("/").includes("..")) {
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

function manifestRequirement(entry, configDirectory) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("requirement entry must be an object");
  const id = validString(entry.id, "requirement id");
  if (!CHECK_ID.test(id)) throw new Error("requirement id must use namespace:name lowercase identifiers");
  return {
    id,
    path: globPattern(entry.path, "requirement path", { bounded: true }),
    configDirectory,
  };
}

async function discoverProjectPolicy(root, changedPaths) {
  const directories = new Set([root]);
  for (const changedPath of changedPaths) {
    let directory = dirname(changedPath);
    while (directory !== ".") {
      directories.add(resolve(root, directory));
      directory = dirname(directory);
    }
  }

  const suppressions = [];
  const requirements = [];
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

    if (!config || typeof config !== "object" || Array.isArray(config)) {
      blockedResults.push(blocked(suppressionResultId(configPath, root), "Invalid verification suppression configuration", "configuration must be an object"));
      continue;
    }
    if (config.suppressions !== undefined && !Array.isArray(config.suppressions)) {
      blockedResults.push(blocked(suppressionResultId(configPath, root), "Invalid verification suppression configuration", "suppressions must be an array"));
    }
    if (config.requirements !== undefined && !Array.isArray(config.requirements)) {
      blockedResults.push(blocked(suppressionResultId(configPath, root), "Invalid verification requirement configuration", "requirements must be an array"));
    }

    for (const entry of Array.isArray(config.suppressions) ? config.suppressions : []) {
      try {
        suppressions.push(manifestSuppression(entry, directory));
      } catch (error) {
        const id = typeof entry?.id === "string" ? entry.id : suppressionResultId(configPath, root);
        blockedResults.push(blocked(id, "Invalid verification suppression configuration", error.message));
      }
    }
    for (const entry of Array.isArray(config.requirements) ? config.requirements : []) {
      try {
        requirements.push(manifestRequirement(entry, directory));
      } catch (error) {
        const id = typeof entry?.id === "string" ? entry.id : suppressionResultId(configPath, root);
        blockedResults.push(blocked(id, "Invalid verification requirement configuration", error.message));
      }
    }
  }
  return { suppressions, requirements, blockedResults };
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

async function manifestCheck(packageName, packagePath, manifestPath, packageVersion, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("verification entry must be an object");

  const id = validString(entry.id, "id");
  if (!CHECK_ID.test(id)) throw new Error("id must use namespace:name lowercase identifiers");
  const label = validString(entry.label, "label");
  const description = validString(entry.description, "description");
  const pathTriggers = verificationPathTriggers(entry);

  if (entry.mode === "agentic") {
    if (entry.entry !== undefined) throw new Error("agentic checks must not declare a deterministic entry");
    const contract = await loadSemanticContract({
      checkId: id,
      packageName,
      packageVersion,
      packagePath,
      contractReference: validString(entry.contract, "contract"),
    });
    return { id, label, description, mode: "agentic", contract, packageName, packagePath, manifestPath, pathTriggers };
  }

  if (entry.mode !== undefined) throw new Error(`unsupported verification mode: ${String(entry.mode)}`);

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

  return { id, label, description, entryPath, packageName, packagePath, manifestPath, pathTriggers, timeoutMs };
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
    const manifestPath = join(directory, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
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
        check = await manifestCheck(
          packageName,
          directory,
          manifestPath,
          typeof manifest.version === "string" ? manifest.version : undefined,
          entry,
        );
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

export async function discoverAutomaticVerification({ repositoryRoot, changedPaths, packageDirectory = defaultPackageDirectory(), workLevel = "normal" }) {
  packageDirectory = resolve(packageDirectory);
  let paths;
  try {
    if (!["normal", "quick-tweak", "rearchitecture"].includes(workLevel)) throw new Error("Unknown request work level");
    paths = [...new Set(changedPaths.map(path => projectPath(path, "changed path")))];
  } catch (error) {
    return {
      results: [blocked("verifier:auto-selection", "Could not select verification checks", error.message)],
      selections: [],
      packageDirectory,
    };
  }

  const { checks, blockedResults } = await discoverVerificationChecks({ packageDirectory });
  const { suppressions, requirements, blockedResults: policyBlocks } = await discoverProjectPolicy(repositoryRoot, paths);
  const plan = planAutomaticVerification({
    checks,
    changedPaths: paths,
    repositoryRoot,
    requirements,
    suppressions,
    blockedResults,
    workLevel,
  });
  return {
    results: [...blockedResults, ...policyBlocks, ...plan.results],
    selections: plan.selections,
    packageDirectory,
  };
}
