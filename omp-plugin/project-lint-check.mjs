import { verifyProjectLint } from "#root/omp-plugin/project-lint.js";
import { openRestartUnits } from "#root/omp-plugin/verification-restart.js";

try {
  const budgetArgument = process.argv[2];
  if (process.argv.length > 3 || (budgetArgument !== undefined && !/^\d+$/.test(budgetArgument))) {
    throw new Error("Expected at most one argument: the project lint budget in milliseconds");
  }

  let budgetMs;
  if (budgetArgument !== undefined) {
    budgetMs = Number(budgetArgument);
  }

  const changedPaths = process.env.OMP_VERIFIER_CHANGED_PATHS === undefined
    ? undefined
    : JSON.parse(process.env.OMP_VERIFIER_CHANGED_PATHS);
  const cwd = process.cwd();
  const restartDirectory = process.env.OMP_VERIFIER_LINT_RESTART_DIRECTORY;
  delete process.env.OMP_VERIFIER_LINT_RESTART_DIRECTORY;
  let restart;
  if (restartDirectory !== undefined) {
    restart = await openRestartUnits(restartDirectory);
  }
  const result = await verifyProjectLint({
    cwd,
    changedPaths,
    budgetMs,
    restart,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "FAIL" || result.status === "BLOCKED" ? 1 : 0;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "BLOCKED",
    summary: "Project lint discovery or execution could not complete",
    evidence: String(error.message).slice(0, 4_000),
    nextCheck: "Restore the named project/tooling prerequisite and rerun verifier:project-lint.",
  })}\n`);
  process.exitCode = 1;
}
