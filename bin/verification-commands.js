import { InvalidArgumentError, Option } from "commander";

import { addReportingOptions, parseWholeNumber } from "#root/bin/cli-options.js";
import { writeJson, writeResults } from "#root/bin/cli-output.js";
import { formatRunTimings, formatVerificationInventory } from "#root/omp-plugin/reporters.js";
import { verifyProjectLint } from "#root/omp-plugin/project-lint.js";
import { readRequestIntent } from "#root/omp-plugin/request-intent.js";
import { verifyResourceCloseout } from "#root/omp-plugin/resource-closeout.js";
import { timeVerificationCheck, timeVerificationRun } from "#root/omp-plugin/run-timings.js";
import { validateSourceByteLimit } from "#root/omp-plugin/semantic-context.js";
import { readTimingHistory } from "#root/omp-plugin/timing-history.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import {
  runAutomaticVerificationForPaths,
  runCurrentAutomaticVerification,
  runInstalledVerificationChecks,
  validateProjectLintBudget,
} from "#root/omp-plugin/verifications.js";

export function registerVerificationCommands(program) {
  const checks = program.command("checks")
    .description("List installed verification checks without executing them");
  addReportingOptions(checks).action(listChecks);

  const timings = program.command("timings")
    .description("Show recent run and check durations for this working directory");
  timings.option("--limit <runs>", "number of recent runs to display (1–50)", parseWholeNumber, 10);
  addReportingOptions(timings).action(showTimings);

  const verify = program.command("verify [check-id...]")
    .description("Run selected installed checks, or all checks when no IDs are supplied")
    .option("--max-source-bytes <bytes>", "source capture budget (16000–256000)", parseSourceByteLimit);
  addReportingOptions(verify, {
    failuresOnly: true,
  }).action(verifyChecks);

  const lint = program.command("lint <changed-path...>")
    .description("Run existing project lint tooling with an explicit time budget")
    .requiredOption("--budget-ms <milliseconds>", "execution budget (1–600000)", parseLintBudget);
  addReportingOptions(lint, {
    failuresOnly: true,
  }).action(lintPaths);

  const base = new Option("--base <ref>", "actual delivery base for changed-path selection")
    .conflicts("worktree");
  const automatic = program.command("automatic [changed-path...]")
    .description("Select checks for changed paths, the current worktree, or declared closeout")
    .option("--worktree", "inspect current worktree changes instead of supplied paths")
    .addOption(base)
    .option("--whole-file <path...>", "include unchanged lines in these selected PR files for cleanup; requires --base")
    .option("--request <intent-handle>", "current request intent for work-level selection")
    .option("--full", "perform full delivery verification; requires --request")
    .option("--lint-budget-ms <milliseconds>", "shared project lint budget (1–600000); requires --full", parseLintBudget)
    .option("--closeout <receipt.json>", "also verify declared final resource dispositions")
    .option("--max-source-bytes <bytes>", "source capture budget (16000–256000)", parseSourceByteLimit);
  addReportingOptions(automatic, {
    failuresOnly: true,
  }).action(verifyAutomatic);
}

async function showTimings(options) {
  if (options.limit < 1 || options.limit > 50) {
    throw new InvalidArgumentError("Timing history limit must be between 1 and 50 runs");
  }
  const runs = await readTimingHistory(process.cwd(), options.limit);
  if (options.reporter === "text") {
    process.stdout.write(`${formatRunTimings(runs)}\n`);
  } else {
    writeJson(runs);
  }
}

function parseSourceByteLimit(value) {
  const limit = parseWholeNumber(value);
  return validateSourceByteLimit(limit);
}

function parseLintBudget(value) {
  const budget = parseWholeNumber(value);
  try {
    validateProjectLintBudget(budget);
  } catch (error) {
    throw new InvalidArgumentError(error.message);
  }
  return budget;
}

async function listChecks(options) {
  const { checks, blockedResults } = await discoverVerificationChecks();
  const inventory = {
    checks: checks.map(({ id, label, description, pathTriggers, mode }) => ({
      id,
      label,
      description,
      ...(pathTriggers ? { pathTriggers } : {}),
      ...(mode === "agentic" ? { mode } : {}),
    })),
    blockedResults,
  };
  let output;
  if (options.reporter === "text") output = formatVerificationInventory(inventory);
  else output = JSON.stringify(inventory);
  process.stdout.write(`${output}\n`);
  process.exitCode = blockedResults.length > 0 ? 1 : 0;
}

async function verifyChecks(ids, options) {
  const cwd = process.cwd();
  const results = await timeVerificationRun(cwd, "verify", () => runInstalledVerificationChecks({
    cwd,
    ids,
    maxSourceBytes: options.maxSourceBytes,
  }));
  await writeResults(results, options);
}

async function lintPaths(paths, options) {
  const cwd = process.cwd();
  const results = await timeVerificationRun(cwd, "lint", () => lintResults(cwd, paths, options.budgetMs));
  await writeResults(results, options);
}

async function lintResults(cwd, paths, budgetMs) {
  const result = await timeVerificationCheck(
    "verifier:project-lint",
    () => verifyProjectLint({
      cwd,
      changedPaths: paths,
      budgetMs,
    }),
    budgetMs,
  );
  const results = [];
  if (result.status !== "N/A") {
    results.push({
      id: "verifier:project-lint",
      ...result,
    });
  }
  return results;
}

async function verifyAutomatic(paths, options) {
  if (options.full && options.request === undefined) throw new Error("--full requires --request");
  if (options.lintBudgetMs !== undefined && !options.full) {
    throw new Error("--lint-budget-ms requires --full");
  }

  if (options.worktree && paths.length > 0) throw new Error("--worktree cannot be combined with changed paths");
  if (options.wholeFile && options.base === undefined) {
    throw new Error("--whole-file requires --base and exact paths in the PR");
  }
  const cwd = process.cwd();
  const results = await timeVerificationRun(cwd, "automatic", () => automaticResults(cwd, paths, options));
  await writeResults(results, options);
}

async function automaticResults(cwd, paths, options) {
  let intent;
  if (options.request !== undefined) {
    try {
      intent = await readRequestIntent(options.request);
    } catch (error) {
      return [{
        id: "verifier:request-intent",
        status: "BLOCKED",
        summary: "Current request intent is unavailable",
        evidence: error.message,
        nextCheck: "Use the active request handle, or run without --request to perform full automatic verification.",
      }];
    }
  }

  let selectionReason = intent?.selectionReason ?? "manual-automatic";
  if (options.full) selectionReason = "full-delivery";
  else if (intent?.selectionReason === "explicit-work-level") selectionReason = `explicit-${intent.level}`;

  const verification = {
    cwd,
    maxSourceBytes: options.maxSourceBytes,
    lintBudgetMs: options.lintBudgetMs,
    workLevel: options.full ? "normal" : intent?.level,
    reuseExisting: !options.full && intent?.level === "normal",
    selectionReason,
  };
  let results = [];
  if (options.worktree) {
    results = await runCurrentAutomaticVerification(verification);
  } else if (paths.length > 0 || options.base !== undefined) {
    results = await runAutomaticVerificationForPaths({
      ...verification,
      changedPaths: paths,
      baseRef: options.base,
      wholeFilePaths: options.wholeFile,
    });
  } else if (options.full && options.closeout === undefined) {
    process.stderr.write(
      "No verification scope supplied; no checks ran and no verdict was produced.\n" +
      "For a PR, use: automatic --request <current-handle> --full --base <ref> <changed-path...>\n",
    );
  }
  if (options.closeout !== undefined) {
    const closeout = await timeVerificationCheck("verifier:resource-closeout", () => verifyResourceCloseout({
      cwd,
      receiptPath: options.closeout,
    }));
    results.push(closeout);
  }
  return results;
}
