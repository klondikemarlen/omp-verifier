# OMP Verifier

OMP verifier agents, commands, and planning helpers for evidence-first PR QA.

## What it does

`/verify-pr <repo> <pr-number>` starts a verifier turn that asks OMP to prove or disprove the PR claim with targeted evidence.

The plugin keeps side effects explicit:

- agent prompts describe verifier behavior;
- slash commands hand off work to the agent;
- tools return plans or Markdown only;
- app booting and GitHub PR posting are not automated yet.

This repo is the verifier-focused layer on top of [Marlen's Skills, Rules, and Tools](https://github.com/klondikemarlen/marlens-skills-rules-and-tools): keep reusable verification behavior here, and keep stack-specific rules in each target project.

## Install

Private GitHub repos must use SSH. The `github:klondikemarlen/omp-verifier` shorthand resolves through Bun's GitHub tarball path and is not reliable for private repos.

```bash
omp plugin install git+ssh://git@github.com/klondikemarlen/omp-verifier.git
```

If you previously installed from another source and remote install fails, reset the installed plugin first:

```bash
omp plugin uninstall omp-verifier
omp plugin install git+ssh://git@github.com/klondikemarlen/omp-verifier.git
```

For local development, link the working tree so OMP loads your checkout:

```bash
omp plugin link ~/code/klondikemarlen/omp-verifier
```

Then restart OMP or run `/reload-plugins`.

## What this package provides

- `agents/verifier.md` - generic verification agent.
- `agents/project-verifier.md` - generic project-aware verifier that reads local repo conventions first.
- `/verify-pr <repo> <pr-number>` - starts an evidence-first verification turn.
- `/verifier-info` - shows loaded commands/tools.
- `verify_pr_plan` - builds a Gold-first verification plan.
- `boot_app_plan` - derives PR-specific app boot env/ports; it does not start services.
- `format_pr_comment` - formats PASS/FAIL/BLOCKED PR evidence; it does not post to GitHub.

This release wires the agent prompts, command handoff, extension hook, and pure planning helpers. Real app booting and PR comment posting should be added behind explicit tools before this README claims those behaviors are automated.

## How to use the verifier

1. Install or link the plugin.
2. Restart OMP or run `/reload-plugins`.
3. Confirm OMP loaded the plugin:

   ```text
   /verifier-info
   ```

4. Start a verification handoff:

   ```text
   /verify-pr ~/code/klondikemarlen/some-project 123
   ```

5. The verifier should inspect the target repo, define the Gold outcome, run targeted checks, and return `PASS`, `FAIL`, or `BLOCKED` with evidence.

Use `agents/verifier.md` for generic completed-change verification. Use `agents/project-verifier.md` when the target repo has local conventions the verifier must read before checking.

## Per-project customization

This repo is the generic base layer. Project-local rules win.

Put project-specific verifier guidance in the target project, not here:

- `AGENTS.md` for repo rules, setup, test commands, database conventions, and verification expectations.
- `README.md` or `bin/README.md` for app boot and dev-wrapper commands.
- `COMMITTING.md` for commit style.
- `.omp/agents/<project>-verifier.md` or `agents/<project>-verifier.md` for project-specific verifier prompts.
- Local skills/rules for project-only shortcuts.

Keep this package generic: SQL verification can mention migrations, query shape, indexes, data safety, and rollback behavior. Vendor-specific rules such as MSSQL style, PostgreSQL extensions, Rails conventions, or Docker service names belong in the target repo.

Useful OMP docs:

- Extensions: https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- Extension loading: https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md

## Philosophy

Inspired by Agentic Engineer concepts:

- Start from Gold.
- Use the core four: context, model, prompt, tools.
- Trust comes from evidence, not summaries.
- Don't talk, execute.
- Keep one specialized verifier before adding orchestration.
- Use sandboxes/worktrees to defer trust until merge.

## Code organization

- `omp-plugin/` wires OMP commands, hooks, and tool registration.
- `tools/` contains pure planning and formatting helpers.
- `agents/` contains task-agent prompts discovered by OMP plugin installs.
- `AGENTS.md` and `COMMITTING.md` capture repo-local agent and commit conventions.
- `CHANGELOG.md` records release-facing changes.

## Verification

```bash
npm run release:check
```

That runs syntax checks for the extension/helpers and the plugin smoke test.

## Release checklist

This is a GitHub plugin release, not an npm or Marketplace publish.

1. Update `package.json` version and `CHANGELOG.md`.
2. Run:

   ```bash
   npm run release:check
   ```

3. Commit using `COMMITTING.md`.
4. Push `main`.
5. Reinstall from the remote:

   ```bash
   npm run reinstall
   ```

   If the install source changed, reset first:

   ```bash
   omp plugin uninstall omp-verifier
   npm run reinstall
   ```

6. Restart OMP or run `/reload-plugins`.
7. Confirm the installed plugin loads:

   ```text
   /verifier-info
   ```

## Concepts

See [CONCEPTS.md](./CONCEPTS.md) for the verifier workflow, install lessons, release flow, and current runtime limits.
