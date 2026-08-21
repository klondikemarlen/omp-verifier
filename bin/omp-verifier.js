#!/usr/bin/env node
import { runAutomaticVerificationForPaths, runCurrentAutomaticVerification } from "#@/omp-plugin/verifications.js";

const [command, ...paths] = process.argv.slice(2);
const useWorkingTree = paths.length === 1 && paths[0] === "--worktree";

if (command !== "automatic" || (paths.includes("--worktree") && !useWorkingTree)) {
  process.stderr.write("Usage: omp-verifier automatic [--worktree|<changed-path>...]\n");
  process.exitCode = 2;
} else {
  const results = paths.length === 0
    ? []
    : useWorkingTree
      ? await runCurrentAutomaticVerification({ cwd: process.cwd() })
      : await runAutomaticVerificationForPaths({ cwd: process.cwd(), changedPaths: paths });
  process.stdout.write(`${JSON.stringify(results)}\n`);
  process.exitCode = results.some(result => result.status === "FAIL" || result.status === "BLOCKED") ? 1 : 0;
}
