#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  prepareDeliveryHandoff,
  recoverDeliveryHandoff,
  releaseDeliveryHandoff,
} from "#root/omp-plugin/delivery-handoff.js";
import { formatVerificationInventory, formatVerificationResults } from "#root/omp-plugin/reporters.js";
import { verifyProjectLint } from "#root/omp-plugin/project-lint.js";
import { validateSourceByteLimit } from "#root/omp-plugin/semantic-context.js";
import { discoverVerificationChecks } from "#root/omp-plugin/verification-catalog.js";
import { readRequestIntent } from "#root/omp-plugin/request-intent.js";
import {
  runAutomaticVerificationForPaths,
  runCurrentAutomaticVerification,
  runInstalledVerificationChecks,
} from "#root/omp-plugin/verifications.js";
import {
  completeSemanticEvaluation,
  readSemanticEvaluation,
  recordSemanticReviewPage,
} from "#root/omp-plugin/semantic-evaluations.js";
import {
  buildSemanticReviewPage,
  formatSemanticReviewPage,
  serializeSemanticReviewResults,
} from "#root/omp-plugin/semantic-review-pages.js";

const [command, ...args] = process.argv.slice(2);
const cwd = process.cwd();

async function writeResults(results, { reporter, failuresOnly, pageIndex = 0 }) {
  const failures = results.filter(result => result.status === "FAIL" || result.status === "BLOCKED");
  let reported = results;
  if (failuresOnly) {
    reported = results.filter(result =>
      result.status === "FAIL" || result.status === "BLOCKED" || result.status === "PENDING" || result.status === "SUPERSEDED",
    );
  }

  let output;
  let reviewPage;
  if (reporter === "text" && reported.length === 1 && reported[0]?.reviewRequest) {
    const result = reported[0];
    let currentPageIndex = pageIndex;
    if (result.evaluation?.supersededBy) currentPageIndex = 0;
    else if (result.reviewProgress?.nextPage !== undefined) currentPageIndex = result.reviewProgress.nextPage;

    reviewPage = buildSemanticReviewPage(result, currentPageIndex);
    output = formatSemanticReviewPage(reviewPage);
  } else if (reporter === "text") {
    output = formatVerificationResults(reported);
  } else if (command === "review") {
    output = serializeSemanticReviewResults(reported);
  } else {
    output = JSON.stringify(reported);
  }

  if (output) {
    await new Promise((resolve, reject) => {
      process.stdout.write(`${output}\n`, error => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (reviewPage && reported[0].status === "PENDING") {
      await recordSemanticReviewPage({ cwd, page: reviewPage });
    }
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

async function automaticResults(paths, worktree, baseRef, maxSourceBytes, requestHandle, full) {
  let intent;
  if (requestHandle !== undefined) {
    try {
      intent = await readRequestIntent(requestHandle);
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
  const options = {
    cwd,
    maxSourceBytes,
    workLevel: full ? "normal" : intent?.level,
    reuseExisting: !full && intent?.level === "normal",
  };
  if (worktree) return runCurrentAutomaticVerification(options);
  if (paths.length === 0 && baseRef === undefined) return [];

  return runAutomaticVerificationForPaths({ ...options, changedPaths: paths, baseRef });
}

async function handoffCommand(positionals, values, reporter) {
  const [action, handoffPath] = positionals;
  const prepare = action === "prepare" && positionals.length === 1 && values.base !== undefined;
  const recover = action === "recover" && positionals.length === 2 && values.base === undefined;
  const release = action === "release" && positionals.length === 2 && values.base === undefined;
  const cancel = action === "cancel" && positionals.length === 2 && values.base === undefined && values.reason?.trim();
  if (!(prepare || recover || release || cancel) || (values.reason !== undefined && !cancel)) {
    throw new Error("Use handoff prepare --base <base>, handoff recover|release <handoff-file>, or handoff cancel <handoff-file> --reason <reason>");
  }

  try {
    let result;
    if (prepare) result = await prepareDeliveryHandoff({ cwd, baseRef: values.base });
    else if (recover) result = await recoverDeliveryHandoff({ handoffPath });
    else result = await releaseDeliveryHandoff({ handoffPath, cancellationReason: values.reason });
    process.stdout.write(`${JSON.stringify(result, null, reporter === "text" ? 2 : undefined)}\n`);
  } catch (error) {
    await writeResults([{
      id: "verifier:delivery-handoff",
      status: "BLOCKED",
      summary: "Delivery source handoff could not complete",
      evidence: error.message,
      nextCheck: "Resolve the named source or handoff prerequisite; do not substitute another checkout or treat cleanup as verification.",
    }], { reporter, failuresOnly: false });
  }
}

try {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      reporter: { type: "string", default: "json" },
      "max-source-bytes": { type: "string" },
      "budget-ms": { type: "string" },
      "failures-only": { type: "boolean", default: false },
      worktree: { type: "boolean", default: false },
      base: { type: "string" },
      request: { type: "string" },
      full: { type: "boolean", default: false },
      assessment: { type: "string" },
      context: { type: "string", multiple: true, default: [] },
      "caller-context": { type: "string", multiple: true, default: [] },
      "external-context": { type: "string", multiple: true, default: [] },
      "remove-context": { type: "string", multiple: true, default: [] },
      page: { type: "string" },
      reason: { type: "string" },
    },
  });
  let budgetMs;
  if (values["budget-ms"] !== undefined) {
    if (command !== "lint") throw new Error("--budget-ms is only supported by lint");
    if (!/^\d+$/.test(values["budget-ms"])) throw new Error("--budget-ms must be a whole number between 1 and 600000");
    budgetMs = Number(values["budget-ms"]);
  }
  let maxSourceBytes;
  if (values["max-source-bytes"] !== undefined) {
    if (command !== "automatic" && command !== "verify") {
      throw new Error("--max-source-bytes is only supported by fresh automatic or verify commands");
    }
    if (!/^\d+$/.test(values["max-source-bytes"]) || !Number.isSafeInteger(Number(values["max-source-bytes"]))) {
      throw new Error("--max-source-bytes must be a whole number between 16000 and 256000");
    }
    maxSourceBytes = validateSourceByteLimit(Number(values["max-source-bytes"]));
  }
  const reporter = values.reporter;
  const failuresOnly = values["failures-only"];
  const hasContextOptions = values.context.length > 0 || values["caller-context"].length > 0
    || values["external-context"].length > 0 || values["remove-context"].length > 0;
  const hasSemanticOptions = values.assessment !== undefined || hasContextOptions;
  const baseRef = values.base;
  if (baseRef !== undefined && command !== "automatic" && command !== "handoff") {
    throw new Error("--base is only supported by automatic or handoff prepare");
  }
  if (baseRef !== undefined && values.worktree) throw new Error("--base cannot be combined with --worktree");
  if (values.reason !== undefined && command !== "handoff") throw new Error("--reason is only supported by handoff cancel");
  if ((values.request !== undefined || values.full) && command !== "automatic") {
    throw new Error("--request and --full are only supported by automatic");
  }
  if (values.full && values.request === undefined) throw new Error("--full requires --request");

  if (reporter !== "json" && reporter !== "text") {
    throw new Error("Reporter must be json or text");
  }

  let pageIndex = 0;
  if (values.page !== undefined) {
    if (command !== "review" || reporter !== "text") {
      throw new Error("--page requires review --reporter text");
    }
    if (!/^\d+$/.test(values.page) || !Number.isSafeInteger(Number(values.page))) {
      throw new Error("Page must be a nonnegative integer");
    }
    pageIndex = Number(values.page);
  }
  if (pageIndex > 0 && hasContextOptions) {
    throw new Error("Context recovery must start at page 0; read later pages from the renewed request without context options");
  }

  if (command === "handoff" && !values.worktree && !failuresOnly && !hasSemanticOptions) {
    await handoffCommand(positionals, values, reporter);
  } else if (command === "checks" && positionals.length === 0 && !values.worktree && !failuresOnly && !hasSemanticOptions) {
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
    const output = reporter === "json" ? JSON.stringify(inventory) : formatVerificationInventory(inventory);
    process.stdout.write(`${output}\n`);
    process.exitCode = blockedResults.length > 0 ? 1 : 0;
  } else if (command === "review" && positionals.length === 1 && !values.worktree && !failuresOnly && values.assessment === undefined) {
    await writeResults([await readSemanticEvaluation({
      cwd,
      requestPath: positionals[0],
      contextPaths: values.context,
      callerContextPaths: values["caller-context"],
      externalContextPaths: values["external-context"],
      removeContextPaths: values["remove-context"],
    })], { reporter, failuresOnly, pageIndex });
  } else if (command === "evaluate" && positionals.length === 1 && !values.worktree && !hasContextOptions && values.assessment !== undefined) {
    const assessmentText = values.assessment === "-" ? readFileSync(0, "utf8") : values.assessment;
    const assessment = JSON.parse(assessmentText);
    await writeResults([await completeSemanticEvaluation({ cwd, requestPath: positionals[0], assessment })], { reporter, failuresOnly });
  } else if (command === "lint" && positionals.length > 0 && budgetMs !== undefined && !values.worktree && !hasSemanticOptions) {
    const result = await verifyProjectLint({ cwd, changedPaths: positionals, budgetMs });
    await writeResults(result.status === "N/A" ? [] : [{ id: "verifier:project-lint", ...result }], { reporter, failuresOnly });
  } else if (command === "verify" && !values.worktree && !hasSemanticOptions) {
    await writeResults(await runInstalledVerificationChecks({
      cwd,
      ids: positionals,
      maxSourceBytes,
    }), { reporter, failuresOnly });
  } else if (command === "automatic" && (!values.worktree || positionals.length === 0) && !hasSemanticOptions) {
    await writeResults(await automaticResults(positionals, values.worktree, baseRef, maxSourceBytes, values.request, values.full), { reporter, failuresOnly });
  } else {
    throw new Error("Invalid command or arguments");
  }
} catch (error) {
  process.stderr.write(`${error.message}\nUsage: omp-verifier handoff prepare --base <base> | handoff recover|release <handoff-file> | handoff cancel <handoff-file> --reason <reason> | checks | lint --budget-ms <milliseconds> <changed-path>... [--reporter json|text] [--failures-only] | verify [<check-id>...] [--max-source-bytes <bytes>] | automatic [--base <ref>] [--request <intent-handle> [--full]] [--max-source-bytes <bytes>] [--worktree|<changed-path>...] | review <request-file> [--context <path[#Lstart-Lend]>...] [--caller-context <path[#Lstart-Lend]>...] [--external-context <pinned-raw-GitHub-URL[#Lstart-Lend]>...] [--remove-context <retained-selector>...] [--reporter json|text] [--page <index>] | evaluate <request-file> --assessment <JSON|-> [--reporter json|text] [--failures-only]\n`);
  process.exitCode = 2;
}
