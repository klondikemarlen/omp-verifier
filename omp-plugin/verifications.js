import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareSemanticEvaluation } from "#root/omp-plugin/semantic-evaluations.js";
import { discoverAutomaticVerification, discoverVerificationChecks, projectPath } from "#root/omp-plugin/verification-catalog.js";
import { captureDeliveryScope } from "#root/omp-plugin/delivery-scope.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64_000;
const MAX_FIELD_LENGTH = 4_000;
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const NODE_RUNTIME = "node";
const AUTOMATIC_SOURCE_RECOVERY = Object.freeze({
  chunkBytes: 16_000,
  maxSourceBytes: 256_000,
  modelContext: "unavailable",
});

function blocked(id, summary, evidence) {
  return { id, status: "BLOCKED", summary, ...(evidence ? { evidence } : {}) };
}

function validString(value, name, required = true) {
  if (typeof value !== "string" || (required && !value.trim()) || value.length > MAX_FIELD_LENGTH) {
    throw new Error(`${name} must be a ${required ? "non-empty " : ""}string no longer than ${MAX_FIELD_LENGTH} characters`);
  }
  return value;
}

function resultFromOutput(check, output) {
  if (output.length > MAX_OUTPUT_BYTES) return blocked(check.id, "Verification output exceeded the limit");

  let result;
  try {
    result = JSON.parse(output);
  } catch {
    return {
      ...blocked(check.id, "Verification did not return one JSON result", output.slice(0, MAX_FIELD_LENGTH) || "Check stdout was empty."),
      nextCheck: `Fix ${check.id} to write one JSON object with status and summary, then rerun that check.`,
    };
  }

  try {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("result must be an object");
    const summary = validString(result.summary, "summary");
    if (result.status === "N/A") return null;
    if (!STATUSES.has(result.status)) throw new Error("status must be PASS, FAIL, BLOCKED, or N/A");
    const evidence = result.evidence === undefined ? undefined : validString(result.evidence, "evidence", false);
    const nextCheck = result.nextCheck === undefined ? undefined : validString(result.nextCheck, "nextCheck", false);
    return { id: check.id, status: result.status, summary, ...(evidence ? { evidence } : {}), ...(nextCheck ? { nextCheck } : {}) };
  } catch (error) {
    return blocked(check.id, "Verification returned an invalid result", error.message);
  }
}

function verificationEnvironment(changedPaths) {
  const environment = { ...process.env };
  delete environment.OMP_VERIFIER_CHANGED_PATHS;
  return changedPaths ? { ...environment, OMP_VERIFIER_CHANGED_PATHS: JSON.stringify(changedPaths) } : environment;
}

async function runVerificationCheckWithRoot(check, cwd, changedPaths, repositoryRoot, maxSourceBytes, automaticScope, sourceRecovery, reuseExisting = false) {
  if (check.mode === "agentic") {
    let scopePaths = changedPaths;
    let scopeRoot = repositoryRoot;
    if (!scopePaths) {
      const changeSet = await changedProjectPaths(cwd);
      if (changeSet.error) return blocked(check.id, "Could not inspect changed paths", changeSet.error);
      scopePaths = changeSet.paths;
      scopeRoot = changeSet.repositoryRoot || repositoryRoot;
    } else if (scopeRoot === cwd) {
      const root = await projectRepositoryRoot(cwd);
      if (!root.error) scopeRoot = root.repositoryRoot;
    }
    return prepareSemanticEvaluation({
      check,
      cwd,
      changedPaths: scopePaths,
      repositoryRoot: scopeRoot,
      maxSourceBytes,
      sourceRecovery,
      automaticScope,
      reuseExisting,
    });
  }

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
      if (result?.status === "FAIL" || result?.status === "BLOCKED") return result;
    }
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return blocked(check.id, "Verification output exceeded the limit");
    if (error?.killed || error?.signal === "SIGTERM") return blocked(check.id, "Verification timed out");
    if (typeof error?.code === "number") return blocked(check.id, `Verification exited with code ${error.code}`, String(error.stderr || error.stdout || "").slice(0, MAX_FIELD_LENGTH));
    return blocked(check.id, "Verification could not run", error.message);
  }
}

export async function runVerificationCheck(check, cwd, changedPaths, maxSourceBytes) {
  return runVerificationCheckWithRoot(check, cwd, changedPaths, cwd, maxSourceBytes);
}
export async function runVerificationChecks(checks, cwd, ids = [], maxSourceBytes) {
  const byId = new Map(checks.map(check => [check.id, check]));
  const requestedIds = [...new Set(ids)];
  const selected = requestedIds.length === 0 ? checks : requestedIds.map(id => byId.get(id)).filter(Boolean);
  const unknown = requestedIds.filter(id => !byId.has(id)).map(id => blocked(id, "Verification check is not installed"));
  return [
    ...unknown,
    ...(await Promise.all(selected.map(check => runVerificationCheck(check, cwd, undefined, maxSourceBytes)))).filter(Boolean),
  ];
}

export async function runInstalledVerificationChecks({ cwd, ids = [], packageDirectory, maxSourceBytes }) {
  const { checks, blockedResults } = await discoverVerificationChecks({ packageDirectory });
  const selectedBlocked = ids.length === 0 ? blockedResults : blockedResults.filter(result => ids.includes(result.id));
  const results = [...selectedBlocked, ...(await runVerificationChecks(checks, cwd, ids, maxSourceBytes))];
  if (results.length === 0 && checks.length === 0) {
    results.push(blocked("verifier", "No verification checks are installed"));
  }
  return results;
}

export async function runAutomaticVerification({
  cwd,
  changedPaths,
  packageDirectory,
  repositoryRoot = cwd,
  maxSourceBytes,
  delivery,
  workLevel = "normal",
  reuseExisting = false,
}) {
  const { results, selections, packageDirectory: selectedDirectory } = await discoverAutomaticVerification({
    repositoryRoot, changedPaths, packageDirectory, workLevel,
  });
  const automaticScope = delivery ? {
    packageDirectory: selectedDirectory,
    delivery,
    ...(workLevel === "quick-tweak" ? { workLevel } : {}),
  } : undefined;
  const sourceRecovery = maxSourceBytes === undefined ? AUTOMATIC_SOURCE_RECOVERY : undefined;

  for (const { check, matches, suppressedResults } of selections) {
    results.push(...suppressedResults);
    if (matches.length === 0) continue;
    const result = await runVerificationCheckWithRoot(check, cwd, matches.map(match => match.path), repositoryRoot, maxSourceBytes, automaticScope, sourceRecovery, reuseExisting);
    if (!result) continue;
    results.push({
      ...result,
      matches,
    });
  }
  return results;
}

export async function runAutomaticVerificationForPaths({ cwd, changedPaths = [], baseRef, packageDirectory, maxSourceBytes, workLevel, reuseExisting }) {
  const root = await projectRepositoryRoot(cwd);
  if (root.error) {
    if (baseRef !== undefined) return [blocked("verifier:auto-selection", "Could not inspect base changes", root.error)];
    const { checks } = await discoverVerificationChecks({ packageDirectory });
    if (!checks.some(check => check.pathTriggers)) return [];
    return [blocked("verifier:auto-selection", "Could not inspect changed paths", root.error)];
  }
  let delivery;
  if (baseRef !== undefined) {
    try {
      delivery = await captureDeliveryScope({
        repositoryRoot: root.repositoryRoot,
        baseRef,
        candidatePaths: changedPaths.map(path => projectPath(path, "changed path")),
      });
      changedPaths = delivery.changedPaths;
    } catch (error) {
      return [blocked("verifier:auto-selection", "Could not inspect base changes", error.message)];
    }
  }
  return runAutomaticVerification({
    cwd,
    changedPaths,
    packageDirectory,
    repositoryRoot: root.repositoryRoot,
    maxSourceBytes,
    delivery,
    workLevel,
    reuseExisting,
  });
}

export async function runCurrentAutomaticVerification({ cwd, packageDirectory, maxSourceBytes, workLevel, reuseExisting }) {
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
    maxSourceBytes,
    workLevel,
    reuseExisting,
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
