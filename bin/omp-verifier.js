#!/usr/bin/env node
import { parseArgs } from "node:util";

import { formatVerificationInventory, formatVerificationResults } from "#root/omp-plugin/reporters.js";
import {
  discoverVerificationChecks,
  runAutomaticVerificationForPaths,
  runCurrentAutomaticVerification,
  runInstalledVerificationChecks,
} from "#root/omp-plugin/verifications.js";

const [command, ...args] = process.argv.slice(2);
const cwd = process.cwd();

function writeResults(results, { reporter, failuresOnly }) {
  const failures = results.filter(result => result.status === "FAIL" || result.status === "BLOCKED");
  const reported = failuresOnly ? failures : results;
  const output = reporter === "json" ? JSON.stringify(reported) : formatVerificationResults(reported);

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
    },
  });
  const reporter = values.reporter;
  const failuresOnly = values["failures-only"];

  if (reporter !== "json" && reporter !== "text") {
    throw new Error("Reporter must be json or text");
  }

  if (command === "checks" && positionals.length === 0 && !values.worktree && !failuresOnly) {
    const { checks, blockedResults } = await discoverVerificationChecks();
    const inventory = {
      checks: checks.map(({ id, label, description, pathTriggers }) => ({
        id,
        label,
        description,
        ...(pathTriggers ? { pathTriggers } : {}),
      })),
      blockedResults,
    };
    const output = reporter === "json" ? JSON.stringify(inventory) : formatVerificationInventory(inventory);
    process.stdout.write(`${output}\n`);
    process.exitCode = blockedResults.length > 0 ? 1 : 0;
  } else if (command === "verify" && !values.worktree) {
    writeResults(await runInstalledVerificationChecks({ cwd, ids: positionals }), { reporter, failuresOnly });
  } else if (command === "automatic" && (!values.worktree || positionals.length === 0)) {
    writeResults(await automaticResults(positionals, values.worktree), { reporter, failuresOnly });
  } else {
    throw new Error("Invalid command or arguments");
  }
} catch (error) {
  process.stderr.write(`${error.message}\nUsage: omp-verifier checks | verify [<check-id>...] | automatic [--worktree|<changed-path>...] [--reporter json|text] [--failures-only]\n`);
  process.exitCode = 2;
}
