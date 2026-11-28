import { InvalidArgumentError, Option } from "commander";

import { addReportingOptions, parseLintBudget, parseWholeNumber } from "#root/bin/cli-options.js";
import { writeJson, writeResults } from "#root/bin/cli-output.js";
import { addRequestOption, resolveVerificationInvocation } from "#root/bin/request-invocation.js";
import { formatRunTimings, formatVerificationInventory } from "#root/omp-plugin/reporters.js";
import { verifyProjectLint } from "#root/omp-plugin/project-lint.js";
import { verifyResourceCloseout } from "#root/omp-plugin/resource-closeout.js";
import { timeVerificationCheck, timeVerificationRun, verificationCancellationSignal } from "#root/omp-plugin/run-timings.js";
import { validateSourceByteLimit } from "#root/omp-plugin/semantic-context.js";
import { readTimingHistory } from "#root/omp-plugin/timing-history.js";
import { defaultPackageDirectory, discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import { withVerificationRestart } from "#root/omp-plugin/verification-restart.js";
import { waivedVerificationResult } from "#root/omp-plugin/waived-verification-result.js";
import {
  runAutomaticVerificationForPaths,
  runCurrentAutomaticVerification,
  runInstalledVerificationChecks,
} from "#root/omp-plugin/verifications.js";

const freshDescription = "discard saved work from an interrupted matching run";

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
    .option("--fresh", freshDescription)
    .option("--max-source-bytes <bytes>", "source capture budget (16000–256000)", parseSourceByteLimit);
  addRequestOption(verify);
  addReportingOptions(verify, {
    failuresOnly: true,
  }).action(verifyChecks);

  const lint = program.command("lint <changed-path...>")
    .description("Run existing project lint tooling with an explicit time budget")
    .option("--fresh", freshDescription)
    .requiredOption("--budget-ms <milliseconds>", "execution budget (1–600000)", parseLintBudget);
  addRequestOption(lint);
  addReportingOptions(lint, {
    failuresOnly: true,
  }).action(lintPaths);

  const base = new Option("--base <ref>", "actual delivery base for changed-path selection")
    .conflicts("worktree");
  const automatic = program.command("automatic [changed-path...]")
    .description("Select checks for changed paths, the current worktree, or declared closeout")
    .option("--fresh", freshDescription)
    .option("--progress", "report coordinator and check progress to stderr even when piped")
    .option("--worktree", "inspect current worktree changes instead of supplied paths")
    .addOption(base)
    .option("--whole-file <path...>", "include unchanged lines in these selected PR files for cleanup; requires --base")
    .option("--full", "perform full delivery verification; requires --request")
    .option("--lint-budget-ms <milliseconds>", "shared project lint budget (1–600000); requires --full", parseLintBudget)
    .option("--closeout <receipt.json>", "also verify declared final resource dispositions")
    .option("--max-source-bytes <bytes>", "source capture budget (16000–256000)", parseSourceByteLimit);
  addRequestOption(automatic);
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

function runRestartableCommand(command, scope, options, execute, progress) {
  const cwd = process.cwd();
  const run = () => {
    if (scope.waiver) return execute();

    return withVerificationRestart({
      cwd,
      command,
      scope,
      fresh: options.fresh,
      packageDirectory: defaultPackageDirectory(),
      signal: verificationCancellationSignal(),
    }, execute);
  };
  return timeVerificationRun(cwd, command, run, progress);
}

async function verifyChecks(ids, options) {
  let gateId;
  if (ids.length === 1) gateId = ids[0];
  const { result, waiver } = await resolveVerificationInvocation(options.request, gateId);
  if (result) {
    await writeResults([result], options);
    return;
  }

  const cwd = process.cwd();
  const scope = {
    ids,
    maxSourceBytes: options.maxSourceBytes,
    request: options.request,
    waiver,
  };
  const results = await runRestartableCommand("verify", scope, options, () => runInstalledVerificationChecks({
    cwd,
    ids,
    maxSourceBytes: options.maxSourceBytes,
    waiver,
  }));
  await writeResults(results, options);
}

async function lintPaths(paths, options) {
  const { result } = await resolveVerificationInvocation(options.request, "verifier:project-lint");
  if (result) {
    await writeResults([result], options);
    return;
  }

  const cwd = process.cwd();
  const scope = {
    paths,
    budgetMs: options.budgetMs,
  };
  const results = await runRestartableCommand("lint", scope, options, () => lintResults(cwd, paths, options.budgetMs));
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

  let gateId;
  if (options.closeout !== undefined && !options.worktree && paths.length === 0 && options.base === undefined) {
    gateId = "verifier:resource-closeout";
  }
  const { intent, result, waiver } = await resolveVerificationInvocation(options.request, gateId, {
    allowWholeRunWaiver: options.closeout === undefined,
    invalidNextCheck: "Use the active request's host-injected handle and explicit scope. For full PR verification: automatic --request <current-handle> --full --base <actual-PR-base> <changed-path...>.",
  });
  if (result) {
    await writeResults([result], options);
    return;
  }

  let selectedPaths = paths;
  if (options.base !== undefined && intent) {
    // Host-supplied paths describe the transcript; they do not authorize a draft audit.
    selectedPaths = [];
  } else if (options.wholeFile) {
    selectedPaths = [...paths, ...options.wholeFile];
  }

  const cwd = process.cwd();
  let progress;
  if (options.progress || (process.stdout.isTTY && process.stderr.isTTY)) {
    progress = automaticProgress;
  }

  const scope = {
    paths: selectedPaths,
    worktree: options.worktree,
    base: options.base,
    wholeFile: options.wholeFile,
    request: options.request,
    full: options.full,
    lintBudgetMs: options.lintBudgetMs,
    closeout: options.closeout,
    maxSourceBytes: options.maxSourceBytes,
    waiver,
  };
  const results = await runRestartableCommand(
    "automatic",
    scope,
    options,
    () => automaticResults(cwd, selectedPaths, options, intent, waiver),
    progress,
  );
  await writeResults(results, options);
}

function writeAutomaticProgress(message) {
  process.stderr.write(`[verifier progress] ${message}\n`);
}

const automaticProgress = {
  started() {
    writeAutomaticProgress("Automatic verification started.");
  },
  checkStarted(check, elapsedMs) {
    let details = `${elapsedMs} ms run elapsed`;
    if (check.timeoutMs !== undefined) {
      details += `; enforced timeout: ${check.timeoutMs} ms`;
    }

    writeAutomaticProgress(`Check ${check.id} started (${details}).`);
  },
  checkReturned(check) {
    writeAutomaticProgress(`Check ${check.id} returned ${check.status} (${check.durationMs} ms check elapsed).`);
  },
  checkRestored(check) {
    writeAutomaticProgress(`Check ${check.id} restored ${check.status} from the interrupted run.`);
  },
  cancelled(signal, elapsedMs) {
    writeAutomaticProgress(`Automatic verification cancelled by ${signal} (${elapsedMs} ms elapsed).`);
  },
  finished(elapsedMs) {
    writeAutomaticProgress(`Automatic verification coordinator finished (${elapsedMs} ms elapsed).`);
  },
};

async function automaticResults(cwd, paths, options, intent, waiver) {
  let selectionReason = intent?.selectionReason ?? "manual-automatic";
  if (options.full) selectionReason = "full-delivery";
  else if (intent?.selectionReason === "explicit-work-level") selectionReason = `explicit-${intent.level}`;

  const verification = {
    cwd,
    maxSourceBytes: options.maxSourceBytes,
    lintBudgetMs: options.lintBudgetMs,
    workLevel: options.full ? "normal" : intent?.level,
    reuseExisting: !options.fresh && !options.full && intent?.level === "normal",
    selectionReason,
    waiver,
  };
  let results = [];
  if (waiver?.id === "verification" && (options.worktree || paths.length > 0 || options.base !== undefined)) {
    results.push(waivedVerificationResult(waiver));
  } else if (options.worktree) {
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
    if (waiver?.id === "verifier:resource-closeout") {
      results.push(waivedVerificationResult(waiver));
    } else {
      const closeout = await timeVerificationCheck("verifier:resource-closeout", () => verifyResourceCloseout({
        cwd,
        receiptPath: options.closeout,
      }));
      results.push(closeout);
    }
  }
  return results;
}
