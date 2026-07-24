import { access, readFile, readdir } from "node:fs/promises";
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
const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
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

async function packageDirectories(packageDirectory) {
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

function manifestCheck(packageName, packagePath, entry) {
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

  const timeoutMs = entry.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : entry.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }

  return { id, label, description, entryPath, packageName, timeoutMs };
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
        check = manifestCheck(packageName, directory, entry);
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

export async function runVerificationCheck(check, cwd) {
  try {
    await access(check.entryPath);
    const { stdout, stderr } = await execFileAsync(process.execPath, [check.entryPath], {
      cwd,
      timeout: check.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (stderr) return blocked(check.id, "Verification wrote to stderr", stderr.slice(0, MAX_FIELD_LENGTH));
    return resultFromOutput(check, stdout.trim());
  } catch (error) {
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
