import { verifyProjectLint } from "#root/omp-plugin/project-lint.js";

try {
  const changedPaths = process.env.OMP_VERIFIER_CHANGED_PATHS === undefined
    ? undefined
    : JSON.parse(process.env.OMP_VERIFIER_CHANGED_PATHS);
  const result = await verifyProjectLint({ cwd: process.cwd(), changedPaths });
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
