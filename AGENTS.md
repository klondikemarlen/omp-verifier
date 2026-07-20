# OMP Verifier Agent Notes

This repo ships an OMP plugin whose only product feature is injecting verifier guidance as an OMP advisor.

## Local workflow

- Keep runtime extension code in `omp-plugin/`.
- Keep reusable verifier guidance in `WATCHDOG.md`.
- Run `npm run release:check` before committing.
- After releasing a new version, reinstall the pushed remote plugin before claiming the release is installed:

```bash
npm run reinstall
```

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
- `/verifier uninstall` removes only the marked verifier advisor block.
- Plugin load preserves or restores OMP's stock `default` advisor, then inserts `verifier` as the second advisor.
- Plugin load refreshes the generated guidance file at `<agent-dir>/verifier/WATCHDOG.md`.
- Independent advisors remain untouched.
- Plugin uninstall lifecycle cleanup removes only the marked verifier advisor block and unchanged guidance file when supported by OMP.
- `WATCHDOG.md` is the source copied into named `verifier` entries.
