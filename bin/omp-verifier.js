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
import { completeSemanticEvaluation, readSemanticEvaluation } from "#root/omp-plugin/semantic-evaluations.js";

const [command, ...args] = process.argv.slice(2);
const cwd = process.cwd();

function writeResults(results, { reporter, failuresOnly }) {
  const failures = results.filter(result => result.status === "FAIL" || result.status === "BLOCKED");
  const reported = failuresOnly ? failures : results;
  let output;
  if (reporter === "text") {
    output = formatVerificationResults(reported);
  } else if (command === "review") {
    output = JSON.stringify(reported, function (key, value) {
      if (key === "content" && typeof value === "string") {
        const startLine = this.startLine ?? 1;
        return Object.fromEntries(value.split(/\r?\n/).map((line, index) => [startLine + index, line]));
      }
      if (key === "text" && typeof value === "string") {
        return value.split(/\r?\n/);
      }
      return value;
    }, 2);
  } else {
    output = JSON.stringify(reported);
  }

  if (output) {
    process.stdout.write(`${output}\n`);
  }

  process.exitCode = failures.length > 0 ? 1 : 0;
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
    },
  });
  const reporter = values.reporter;
  const failuresOnly = values["failures-only"];
  const hasSemanticOptions = values.assessment !== undefined || values.context.length > 0;

  if (reporter !== "json" && reporter !== "text") {
    throw new Error("Reporter must be json or text");
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
  } else if (command === "review" && positionals.length === 1 && reporter === "json" && !values.worktree && !failuresOnly && values.assessment === undefined) {
    writeResults([await readSemanticEvaluation({ cwd, requestPath: positionals[0], contextPaths: values.context })], { reporter, failuresOnly });
  } else if (command === "evaluate" && positionals.length === 1 && !values.worktree && values.context.length === 0 && values.assessment !== undefined) {
    const assessmentText = values.assessment === "-" ? readFileSync(0, "utf8") : values.assessment;
    const assessment = JSON.parse(assessmentText);
    writeResults([await completeSemanticEvaluation({ cwd, requestPath: positionals[0], assessment })], { reporter, failuresOnly });
  } else if (command === "verify" && !values.worktree && !hasSemanticOptions) {
    writeResults(await runInstalledVerificationChecks({ cwd, ids: positionals }), { reporter, failuresOnly });
  } else if (command === "automatic" && (!values.worktree || positionals.length === 0) && !hasSemanticOptions) {
    writeResults(await automaticResults(positionals, values.worktree), { reporter, failuresOnly });
  } else {
    throw new Error("Invalid command or arguments");
  }
} catch (error) {
  process.stderr.write(`${error.message}\nUsage: omp-verifier checks | verify [<check-id>...] | automatic [--worktree|<changed-path>...] | review <request-file> [--context <path[#Lstart-Lend]>...] | evaluate <request-file> --assessment <JSON|-> [--reporter json|text] [--failures-only]\n`);
  process.exitCode = 2;
}
