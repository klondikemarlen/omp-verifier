# OMP Verifier

Evidence-first OMP verifier agent scaffold for PR QA.

## Install

```bash
omp plugin install git+ssh://git@github.com/klondikemarlen/omp-verifier.git
```

The shorter `github:klondikemarlen/omp-verifier` form does not work while this repo is private because Bun resolves it through GitHub's tarball API.

For local development:

```bash
omp plugin link ~/code/klondikemarlen/omp-verifier
```

Restart OMP after changing agents or extension code so discovery reloads.

## What v0.1 provides

- `agents/verifier.md` - generic verification agent.
- `agents/wrap-verifier.md` - WRAP-style PR QA verifier.
- `/verify-pr <repo> <pr-number>` - starts an evidence-first verification turn.
- `/verifier-info` - shows loaded commands/tools.
- `verify_pr_plan` - builds a Gold-first verification plan.
- `boot_app_plan` - derives PR-specific app boot env/ports; it does not start services yet.
- `format_pr_comment` - formats PASS/FAIL/BLOCKED PR evidence; it does not post to GitHub yet.

This first release wires the agent, command, hook, and planning tools. Actual app booting and PR comment posting are the next runtime step.

## Philosophy

Inspired by Agentic Engineer concepts:

- Start from Gold.
- Use the core four: context, model, prompt, tools.
- Trust comes from evidence, not summaries.
- Don't talk, execute.
- Keep one specialized verifier before adding orchestration.
- Use sandboxes/worktrees to defer trust until merge.

## Verification

```bash
npm run check
```
