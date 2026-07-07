# OMP Verifier Agent Notes

This repo ships an OMP plugin that adds verifier-focused agents, commands, and planning tools.

## Local workflow

- Keep runtime extension code in `omp-plugin/`.
- Keep pure planning helpers in `tools/`.
- Keep task-agent prompts in `agents/`.
- Run `npm run release:check` before committing.
- Reinstall from the remote plugin after pushing when testing reload behavior:

```bash
npm run reinstall
```

## Product rule

Verifier output must be evidence-first:

- Start from Gold.
- Run or specify targeted checks.
- Report `PASS`, `FAIL`, or `BLOCKED`.
- Do not call a verification successful without observed evidence.

## Scope

This repo currently provides the v0.1 scaffold: agents, slash command handoff, and planning/formatting tools. Real app booting and GitHub PR posting should be added behind explicit tools before the README claims those behaviors are automated.
