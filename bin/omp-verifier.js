#!/usr/bin/env node
import {
  discoverVerificationChecks,
  runAutomaticVerificationForPaths,
  runCurrentAutomaticVerification,
  runInstalledVerificationChecks,
} from "#root/omp-plugin/verifications.js";

const [command, ...args] = process.argv.slice(2);
const cwd = process.cwd();

function writeResults(results) {
  process.stdout.write(`${JSON.stringify(results)}\n`);
  process.exitCode = results.some(result => result.status === "FAIL" || result.status === "BLOCKED") ? 1 : 0;
}

async function automaticResults(paths) {
  if (paths.length === 0) return [];
  if (paths.length === 1 && paths[0] === "--worktree") {
    return runCurrentAutomaticVerification({ cwd });
  }
  return runAutomaticVerificationForPaths({ cwd, changedPaths: paths });
}

if (command === "checks" && args.length === 0) {
  const { checks, blockedResults } = await discoverVerificationChecks();
  const inventory = checks.map(({ id, label, description, pathTriggers }) => ({
    id,
    label,
    description,
    ...(pathTriggers ? { pathTriggers } : {}),
  }));
  process.stdout.write(`${JSON.stringify({ checks: inventory, blockedResults })}\n`);
  process.exitCode = blockedResults.length > 0 ? 1 : 0;
} else if (command === "verify" && !args.some(argument => argument.startsWith("--"))) {
  writeResults(await runInstalledVerificationChecks({ cwd, ids: args }));
} else if (command === "automatic" && (!args.includes("--worktree") || (args.length === 1 && args[0] === "--worktree"))) {
  writeResults(await automaticResults(args));
} else {
  process.stderr.write("Usage: omp-verifier checks | verify [<check-id>...] | automatic [--worktree|<changed-path>...]\n");
  process.exitCode = 2;
}
