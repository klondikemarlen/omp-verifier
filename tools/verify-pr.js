export function buildVerificationPlan({ repo, pr }) {
  const worktree = `${repo.replace(/\/$/, "")}/.verifier-worktrees/pr-${pr}`;

  return [
    `Gold outcome: define the behavior PR #${pr} must prove before running checks.`,
    "",
    "Context:",
    `- target repo: ${repo}`,
    `- sandbox: ${worktree}`,
    `- PR: #${pr}`,
    "",
    "Execution:",
    "1. Inspect PR diff and changed call paths.",
    "2. Create or reuse the isolated PR worktree.",
    "3. Derive PR-specific ports/env before booting services.",
    "4. Run the smallest targeted tests or browser QA scenario.",
    "5. Collect command output, screenshots, URLs, and failures.",
    "6. Report PASS | FAIL | BLOCKED with evidence.",
    "",
    "Trust rule: no evidence, no pass.",
  ].join("\n");
}
