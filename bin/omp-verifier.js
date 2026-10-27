#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { formatVerificationInventory, formatVerificationResults } from "#root/omp-plugin/reporters.js";
import {
  discoverVerificationChecks,
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
  const pending = results.some(result => result.status === "PENDING");
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
  } else if (pending && command !== "review") {
    process.exitCode = 3;
  } else {
    process.exitCode = 0;
  }
}

async function automaticResults(paths, worktree) {
  if (worktree) {
    return runCurrentAutomaticVerification({ cwd });
  }

  if (paths.length === 0) {
    return [];
  }

  return runAutomaticVerificationForPaths({ cwd, changedPaths: paths });
}

try {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      reporter: { type: "string", default: "json" },
      "failures-only": { type: "boolean", default: false },
      worktree: { type: "boolean", default: false },
      assessment: { type: "string" },
      context: { type: "string", multiple: true, default: [] },
      "caller-context": { type: "string", multiple: true, default: [] },
      page: { type: "string" },
    },
  });
  const reporter = values.reporter;
  const failuresOnly = values["failures-only"];
  const hasSemanticOptions = values.assessment !== undefined || values.context.length > 0 || values["caller-context"].length > 0;

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
  if (pageIndex > 0 && (values.context.length > 0 || values["caller-context"].length > 0)) {
    throw new Error("Context recovery must start at page 0; read later pages from the renewed request without context options");
  }

  if (command === "checks" && positionals.length === 0 && !values.worktree && !failuresOnly && !hasSemanticOptions) {
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
    })], { reporter, failuresOnly, pageIndex });
  } else if (command === "evaluate" && positionals.length === 1 && !values.worktree && values.context.length === 0 && values["caller-context"].length === 0 && values.assessment !== undefined) {
    const assessmentText = values.assessment === "-" ? readFileSync(0, "utf8") : values.assessment;
    const assessment = JSON.parse(assessmentText);
    await writeResults([await completeSemanticEvaluation({ cwd, requestPath: positionals[0], assessment })], { reporter, failuresOnly });
  } else if (command === "verify" && !values.worktree && !hasSemanticOptions) {
    await writeResults(await runInstalledVerificationChecks({ cwd, ids: positionals }), { reporter, failuresOnly });
  } else if (command === "automatic" && (!values.worktree || positionals.length === 0) && !hasSemanticOptions) {
    await writeResults(await automaticResults(positionals, values.worktree), { reporter, failuresOnly });
  } else {
    throw new Error("Invalid command or arguments");
  }
} catch (error) {
  process.stderr.write(`${error.message}\nUsage: omp-verifier checks | verify [<check-id>...] | automatic [--worktree|<changed-path>...] | review <request-file> [--context <path[#Lstart-Lend]>...] [--caller-context <path[#Lstart-Lend]>...] [--reporter json|text] [--page <index>] | evaluate <request-file> --assessment <JSON|-> [--reporter json|text] [--failures-only]\n`);
  process.exitCode = 2;
}
