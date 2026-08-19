# OMP Verifier Agent Notes

This repo ships an OMP plugin whose only product feature is injecting verifier guidance as an OMP advisor.

## Local workflow

- Keep runtime extension code in `omp-plugin/`, the packaged CLI in `bin/`, and reusable verifier guidance in `WATCHDOG.md`.
- Every change is a release: issue with acceptance criteria and learner coverage, issue-named branch, linked draft PR, complete self-review, focused QA, required checks, merge commit, remote reinstall, and fresh-process behavior verification.
- Run `npm run release:check` before committing and again after any fixup.
- After merge, fetch and prune, return to synchronized `main`, then reinstall the pushed remote plugin:

```bash
npm run reinstall
```

- Do not claim the release installed until the installed version and changed behavior are observed in a new OMP process.

## Product rule

Less is more. Do not add task agents, planning tools, PR checkout, app booting, GitHub comments, or a custom runtime unless explicitly requested.

Verifier output must be evidence-first:

- Start from Gold.
- Run or specify targeted checks.
- Report `PASS`, `FAIL`, or `BLOCKED`.
- Do not call a verification successful without observed evidence.

## Scope

Current scope:

- `/verifier` and `/verifier status` report global and project advisor rosters.
- `/verifier checks` and `/verifier verify` expose explicit manifest checks.
- `/verifier uninstall` removes only the marked verifier advisor block.
- Plugin load preserves or restores OMP's stock `default` advisor, then inserts `verifier` second with `bash`.
- Plugin load refreshes `<agent-dir>/verifier/WATCHDOG.md` with the coordinator path derived from the installed package.
- The verifier advisor runs automatic checks after changed turns; `PASS`, `SUPPRESSED`, and no results stay silent, while `FAIL` and `BLOCKED` use standard blocker advice.
- Independent advisors remain untouched.
- Plugin uninstall cleanup removes only the marked verifier advisor block and unchanged guidance file.
- `WATCHDOG.md` is the generated-guidance template, not a user customization surface.
