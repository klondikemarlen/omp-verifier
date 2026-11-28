import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareSemanticEvaluation } from "#root/omp-plugin/semantic-evaluations.js";
import { defaultPackageDirectory, discoverAutomaticVerification, discoverVerificationChecks, projectPath } from "#root/omp-plugin/verification-catalog.js";
import { captureDeliveryScope } from "#root/omp-plugin/delivery-scope.js";
import { deliveryFindingEligibility, verificationScope } from "#root/omp-plugin/finding-scope.js";
import { markVerificationTimeout, recordRestoredCheck, timeVerificationCheck, verificationCancellationSignal } from "#root/omp-plugin/run-timings.js";
import { currentVerificationRestart } from "#root/omp-plugin/verification-restart.js";
import { waivedVerificationResult } from "#root/omp-plugin/waived-verification-result.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64_000;
const MAX_FIELD_LENGTH = 4_000;
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED"]);
const NODE_RUNTIME = "node";
export const DEFAULT_PROJECT_LINT_BUDGET_MS = 100_000;
export const MAX_PROJECT_LINT_BUDGET_MS = 600_000;
const PROJECT_LINT_PROVIDER_ALLOWANCE_MS = 20_000;
const PROJECT_LINT_ENTRY = "omp-plugin/project-lint-check.mjs";
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
    const installedProjectLint = (result.lintBudgetExhaustedMs !== undefined || result.lintVerdicts !== undefined) &&
      isInstalledProjectLint(check, resolve(defaultPackageDirectory()));
    let lintVerdicts;
    if (installedProjectLint && result.status !== "PASS" &&
      typeof result.lintVerdicts === "string" && result.lintVerdicts.length <= MAX_FIELD_LENGTH) {
      lintVerdicts = result.lintVerdicts;
    }
    let lintBudgetExhaustedMs;
    if (result.lintBudgetExhaustedMs !== undefined && installedProjectLint) {
      validateProjectLintBudget(result.lintBudgetExhaustedMs);
      lintBudgetExhaustedMs = result.lintBudgetExhaustedMs;
    }

    return {
      id: check.id,
      status: result.status,
      summary,
      ...(evidence ? {
        evidence,
      } : {}),
      ...(nextCheck ? {
        nextCheck,
      } : {}),
      ...(lintVerdicts ? {
        lintVerdicts,
      } : {}),
      ...(lintBudgetExhaustedMs !== undefined ? {
        lintBudgetExhaustedMs,
      } : {}),
    };
  } catch (error) {
    return blocked(check.id, "Verification returned an invalid result", error.message);
  }
}

function selectedReviewHunks(delivery, changedPaths, renames = []) {
  if (!delivery.baseRef || !delivery.baseCommit || !delivery.mergeBaseCommit || !delivery.headCommit
    || !delivery.comparisonCommit || !delivery.removedLineRanges
    || typeof delivery.removedLineRanges !== "object" || Array.isArray(delivery.removedLineRanges)
    || delivery.wholeFilePaths.length) {
    throw new Error("Changed-line execution requires both sides of a committed hunk scope");
  }

  const selectedPaths = new Set(changedPaths);

  for (const { from, to } of renames) {
    if (!selectedPaths.has(to) && (delivery.lineRanges[to]?.length || delivery.removedLineRanges[to]?.length)) {
      throw new Error(`Changed hunks for renamed source ${from} are keyed by the unselected destination ${to}`);
    }
  }

  return {
    reviewScope: delivery.reviewScope,
    baseRef: delivery.baseRef,
    comparisonCommit: delivery.comparisonCommit,
    changedPaths,
    renames,
  };
}

function verificationEnvironment(changedPaths, delivery, lintRestartDirectory) {
  const environment = { ...process.env };
  delete environment.OMP_VERIFIER_CHANGED_PATHS;
  delete environment.OMP_VERIFIER_PR_SCOPE;
  delete environment.OMP_VERIFIER_LINT_RESTART_DIRECTORY;
  if (lintRestartDirectory) {
    environment.OMP_VERIFIER_LINT_RESTART_DIRECTORY = lintRestartDirectory;
  }

  if (!changedPaths) {
    return environment;
  }

  environment.OMP_VERIFIER_CHANGED_PATHS = JSON.stringify(changedPaths);
  if (delivery) {
    const eligibility = deliveryFindingEligibility(delivery, changedPaths);
    environment.OMP_VERIFIER_PR_SCOPE = JSON.stringify({
      version: 1,
      baseCommit: delivery.baseCommit,
      mergeBaseCommit: delivery.mergeBaseCommit,
      headCommit: delivery.headCommit,
      ...eligibility,
      ...(delivery.reviewScope === undefined ? {} : selectedReviewHunks(delivery, changedPaths, eligibility.renames)),
    });
  }
  return environment;
}

export function validateProjectLintBudget(budgetMs) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > MAX_PROJECT_LINT_BUDGET_MS) {
    throw new RangeError(`Project lint budget must be a whole number between 1 and ${MAX_PROJECT_LINT_BUDGET_MS} milliseconds`);
  }
}

function isInstalledProjectLint(check, packageDirectory) {
  return check.id === "verifier:project-lint" &&
    check.packageName === "omp-verifier" &&
    check.manifestPath === join(packageDirectory, "omp-verifier", "package.json") &&
    check.entryPath === join(check.packagePath, PROJECT_LINT_ENTRY);
}

async function prepareSemanticCheck(check, cwd, changedPaths, repositoryRoot, maxSourceBytes, automaticScope, sourceRecovery, reuseExisting, selectionReason) {
  let scopePaths = changedPaths;
  let scopeRoot = repositoryRoot;
  if (!scopePaths) {
    const changeSet = await changedProjectPaths(cwd);
    if (changeSet.error) {
      return blocked(check.id, "Could not inspect changed paths", changeSet.error);
    }

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
    selectionReason,
  });
}

async function executeVerificationCheck(check, cwd, environment, timeoutMs, lintBudgetMs) {
  const args = [check.entryPath];
  if (lintBudgetMs !== undefined) {
    args.push(String(lintBudgetMs));
  }

  const signal = verificationCancellationSignal();
  try {
    signal?.throwIfAborted();
    const { stdout, stderr } = await execFileAsync(NODE_RUNTIME, args, {
      cwd,
      env: environment,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      signal,
    });
    if (stderr) return blocked(check.id, "Verification wrote to stderr", stderr.slice(0, MAX_FIELD_LENGTH));
    return resultFromOutput(check, stdout.trim());
  } catch (error) {
    signal?.throwIfAborted();

    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return blocked(check.id, "Verification output exceeded the limit");
    }
    // execFile kills for maxBuffer or timeout; cancellation was handled above.
    if (error?.killed && timeoutMs > 0) {
      return markVerificationTimeout(blocked(check.id, "Verification timed out"));
    }

    if (typeof error?.code === "number" && !error.stderr) {
      const result = resultFromOutput(check, String(error.stdout || "").trim());
      if (result?.status === "FAIL" || result?.status === "BLOCKED") return result;
    }
    if (typeof error?.code === "number") return blocked(check.id, `Verification exited with code ${error.code}`, String(error.stderr || error.stdout || "").slice(0, MAX_FIELD_LENGTH));
    if (error?.signal) {
      const evidence = [`Verification process terminated by ${error.signal}.`, error.stderr].filter(Boolean).join("\n");
      return blocked(check.id, "Verification could not run", evidence.slice(0, MAX_FIELD_LENGTH));
    }

    return blocked(check.id, "Verification could not run", error.message);
  }
}

async function runVerificationCheckWithRoot(check, cwd, changedPaths, repositoryRoot, maxSourceBytes, options = {}) {
  const { automaticScope, sourceRecovery, reuseExisting, selectionReason, lintBudgetMs } = options;
  if (check.mode === "agentic") {
    return timeVerificationCheck(check.id, () =>
      prepareSemanticCheck(check, cwd, changedPaths, repositoryRoot, maxSourceBytes, automaticScope, sourceRecovery, reuseExisting, selectionReason),
    );
  }

  try {
    await access(check.entryPath);
  } catch (error) {
    return blocked(check.id, "Verification could not run", error.message);
  }

  let timeoutMs = check.timeoutMs;
  if (lintBudgetMs !== undefined) {
    timeoutMs = lintBudgetMs + PROJECT_LINT_PROVIDER_ALLOWANCE_MS;
  }

  const restart = currentVerificationRestart();
  const isProjectLint = isInstalledProjectLint(check, resolve(defaultPackageDirectory()));
  const delivery = automaticScope?.delivery;
  let environment;
  try {
    environment = verificationEnvironment(changedPaths, delivery, isProjectLint ? restart?.directory : undefined);
  } catch (error) {
    return blocked(check.id, "Verification could not run", error.message);
  }

  const key = delivery?.reviewScope === undefined
    ? `check:${JSON.stringify([check.id, changedPaths])}`
    : `changed-lines:${check.id}:${environment.OMP_VERIFIER_PR_SCOPE}`;
  if (restart && !isProjectLint) {
    const saved = await restart.read(key);
    if (saved?.id === check.id && saved.status === "PASS") {
      const result = resultFromOutput(check, JSON.stringify(saved));
      if (result?.status === "PASS") {
        recordRestoredCheck(result);
        return result;
      }
    }
  }

  return timeVerificationCheck(check.id, async () => {
    const result = await executeVerificationCheck(check, cwd, environment, timeoutMs, lintBudgetMs);
    if (restart && !isProjectLint && result?.status === "PASS") {
      await restart.save(key, result);
    }
    return result;
  }, timeoutMs);
}

export async function runVerificationCheck(check, cwd, changedPaths, maxSourceBytes) {
  return runVerificationCheckWithRoot(check, cwd, changedPaths, cwd, maxSourceBytes);
}
export async function runVerificationChecks(checks, cwd, ids = [], maxSourceBytes, waiver) {
  const byId = new Map(checks.map(check => [check.id, check]));
  const requestedIds = [...new Set(ids)];
  const selected = requestedIds.length === 0 ? checks : requestedIds.map(id => byId.get(id)).filter(Boolean);
  const unknown = requestedIds.filter(id => !byId.has(id)).map(id => {
    if (id === waiver?.id) return waivedVerificationResult(waiver);

    return blocked(id, "Verification check is not installed");
  });
  const results = await Promise.all(selected.map(check => {
    if (check.id === waiver?.id) return waivedVerificationResult(waiver);

    return runVerificationCheck(check, cwd, undefined, maxSourceBytes);
  }));
  return [
    ...unknown,
    ...results.filter(Boolean),
  ];
}

export async function runInstalledVerificationChecks({ cwd, ids = [], packageDirectory, maxSourceBytes, waiver }) {
  const { checks, blockedResults } = await discoverVerificationChecks({ packageDirectory });
  const selectedBlocked = ids.length === 0 ? blockedResults : blockedResults.filter(result => ids.includes(result.id));
  const results = [...selectedBlocked, ...(await runVerificationChecks(checks, cwd, ids, maxSourceBytes, waiver))];
  if (results.length === 0 && checks.length === 0) {
    results.push(blocked("verifier", "No verification checks are installed"));
  }
  return reportWaivedGate(results, waiver);
}

function reportWaivedGate(results, waiver) {
  if (!waiver) return results;

  const reported = [];
  let reportedWaiver = false;
  for (const result of results) {
    if (result.id !== waiver.id) {
      reported.push(result);
      continue;
    }

    if (!reportedWaiver) {
      reported.push(waivedVerificationResult(waiver));
      reportedWaiver = true;
    }
  }
  return reported;
}

export async function runAutomaticVerification({
  cwd,
  changedPaths,
  packageDirectory,
  repositoryRoot = cwd,
  maxSourceBytes,
  lintBudgetMs,
  delivery,
  workLevel = "normal",
  reuseExisting = false,
  selectionReason = "automatic-normal",
  waiver,
}) {
  if (lintBudgetMs !== undefined) {
    validateProjectLintBudget(lintBudgetMs);
  }

  const { results, selections, packageDirectory: selectedDirectory } = await discoverAutomaticVerification({
    repositoryRoot, changedPaths, packageDirectory, workLevel, isDelivery: Boolean(delivery), reviewScope: delivery?.reviewScope,
  });
  const automaticScope = delivery ? {
    packageDirectory: selectedDirectory,
    delivery,
    ...(workLevel === "quick-tweak" ? { workLevel } : {}),
  } : undefined;
  const sourceRecovery = maxSourceBytes === undefined ? AUTOMATIC_SOURCE_RECOVERY : undefined;

  for (const { check, matches, skippedResults } of selections) {
    if (check.id === waiver?.id) {
      results.push(waivedVerificationResult(waiver));
      continue;
    }

    results.push(...skippedResults);
    if (matches.length === 0) continue;
    const selectedPaths = matches.map(match => match.path);
    const projectLint = isInstalledProjectLint(check, selectedDirectory);

    const result = await runVerificationCheckWithRoot(
      check,
      cwd,
      selectedPaths,
      repositoryRoot,
      maxSourceBytes,
      {
        automaticScope,
        sourceRecovery,
        reuseExisting,
        selectionReason,
        lintBudgetMs: projectLint ? lintBudgetMs : undefined,
      },
    );
    if (!result) continue;
    if (projectLint) {
      result.lintBudgetMs = lintBudgetMs ?? DEFAULT_PROJECT_LINT_BUDGET_MS;
    }
    const scope = result.scope ?? verificationScope(repositoryRoot, selectedPaths, delivery, check.mode === "agentic" ? "semantic-findings" : "provider-owned");
    results.push({
      ...result,
      matches,
      scope,
    });
  }
  return reportWaivedGate(results, waiver);
}

export async function runAutomaticVerificationForPaths({
  cwd,
  changedPaths = [],
  baseRef,
  reviewScope,
  wholeFilePaths = [],
  packageDirectory,
  maxSourceBytes,
  lintBudgetMs,
  workLevel,
  reuseExisting,
  selectionReason,
  waiver,
}) {
  if (reviewScope !== undefined && baseRef === undefined) {
    return [automaticSelectionBlocker(waiver, "Could not inspect base changes", "A delivery review scope requires the actual PR/MR base.")];
  }

  const root = await projectRepositoryRoot(cwd);
  if (root.error) {
    if (baseRef !== undefined) return [automaticSelectionBlocker(waiver, "Could not inspect base changes", root.error)];
    const { checks } = await discoverVerificationChecks({ packageDirectory });
    if (!checks.some(check => check.pathTriggers)) return [];
    return [automaticSelectionBlocker(waiver, "Could not inspect changed paths", root.error)];
  }
  let delivery;
  if (baseRef !== undefined) {
    try {
      delivery = await captureDeliveryScope({
        repositoryRoot: root.repositoryRoot,
        baseRef,
        reviewScope,
        candidatePaths: changedPaths.map(path => projectPath(path, "changed path")),
        wholeFilePaths: wholeFilePaths.map(path => projectPath(path, "whole-file path")),
      });
      changedPaths = delivery.changedPaths;
    } catch (error) {
      return [automaticSelectionBlocker(waiver, "Could not inspect base changes", error.message)];
    }
  }
  return runAutomaticVerification({
    cwd,
    changedPaths,
    packageDirectory,
    repositoryRoot: root.repositoryRoot,
    maxSourceBytes,
    lintBudgetMs,
    delivery,
    workLevel,
    reuseExisting,
    selectionReason,
    waiver,
  });
}

export async function runCurrentAutomaticVerification({
  cwd,
  packageDirectory,
  maxSourceBytes,
  lintBudgetMs,
  workLevel,
  reuseExisting,
  selectionReason,
  waiver,
}) {
  const changeSet = await changedProjectPaths(cwd);
  if (changeSet.error) {
    const { checks } = await discoverVerificationChecks({ packageDirectory });
    if (!checks.some(check => check.pathTriggers)) return [];
    return [automaticSelectionBlocker(waiver, "Could not inspect changed paths", changeSet.error)];
  }
  if (changeSet.paths.length === 0) return [];

  return runAutomaticVerification({
    cwd,
    changedPaths: changeSet.paths,
    packageDirectory,
    repositoryRoot: changeSet.repositoryRoot,
    maxSourceBytes,
    lintBudgetMs,
    workLevel,
    reuseExisting,
    selectionReason,
    waiver,
  });
}

function automaticSelectionBlocker(waiver, summary, evidence) {
  const id = "verifier:auto-selection";
  if (waiver?.id === id) return waivedVerificationResult(waiver);

  return blocked(id, summary, evidence);
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
