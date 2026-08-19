# Committing

Use Marlen's OMP plugin commit style.

## Format

`:emoji: Verb phrase.` — imperative mood, subject line ends with a period.

The subject describes the outcome or user-visible effect, not just the files changed.

Examples:

```text
:hammer: Scaffold evidence-first OMP verifier agents.
:ok_hand: Trigger verifier turns from the PR command.
:memo: Document remote plugin installs.
```

## Emoji guide

- `:sparkles:` — new user-facing capability.
- `:ok_hand:` — adjustment or small behavior fix.
- `:hammer:` — tooling/plugin infrastructure.
- `:memo:` — docs and release notes.
- `:recycle:` — structure-preserving refactor.
- `:bug:` — defect fix.
- `:white_check_mark:` — test coverage.

## Before committing

1. Confirm the change has an issue, acceptance criteria, learner coverage outcome, and issue-named branch.
2. Stage only one logical commit and run `check-commit-scope`.
3. Run:

```bash
npm run release:check
```

After all commits:

1. Open a linked draft pull request.
2. Self-review the complete diff and record focused QA.
3. Resolve actionable feedback and required checks.
4. Mark ready and merge with a merge commit.
5. Fetch and prune, return to synchronized `main`, and remove only the merged agent-owned branch.
6. Run `npm run reinstall`.
7. Start a new OMP process; verify the installed version, `/verifier` completion, and changed behavior.

An advisor-correction claim additionally requires a resolved verifier model in `/advisor status` and an observed automatic failure → blocker → primary remediation → clean follow-up cycle. Existing OMP processes do not reload extension modules after reinstall.
