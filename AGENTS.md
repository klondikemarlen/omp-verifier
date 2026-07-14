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

- `/verifier` and `/verifier status` report active local/global verifier setup and file locations.
- Generated verifier files are created automatically when the plugin loads.
- Plugin uninstall lifecycle cleanup removes generated advisor setup when supported by OMP.
- `WATCHDOG.md` holds upstream verifier guidance imported by downstream `WATCHDOG.yml` files.
