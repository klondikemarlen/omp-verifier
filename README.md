# OMP Verifier

OMP verifier agents, commands, and planning helpers for evidence-first PR QA.

## What it does

OMP Verifier is an advisor-style verification layer.

Primary interface: enable OMP's built-in advisor and point local `WATCHDOG.md` rules at this repo's verifier guidance. The verifier then reviews code-change turns in the background and pushes back when implementation claims lack evidence.

Current OMP caveat: this package does not create a separate `omp-verifier.enabled` settings role today. Always-on behavior uses OMP's built-in `advisor.enabled` runtime plus user/project `WATCHDOG.md` rules.

Optional interface: `/verify-pr <repo> <pr-number>` starts an explicit verifier subagent handoff for PR review.

The plugin keeps side effects explicit:

- `WATCHDOG.md` defines always-on aggressive advisor guidance;
- agent prompts define verifier subagent behavior;
- slash commands hand off work to the agent when requested;
- tools return plans or Markdown only;
- app booting and GitHub PR posting are not automated yet.

This repo is the verifier-focused layer on top of [Marlen's Skills, Rules, and Tools](https://github.com/klondikemarlen/marlens-skills-rules-and-tools): keep reusable verification behavior here, and keep stack-specific rules in each target project.

## Install

Private GitHub repos must use SSH. The `github:klondikemarlen/omp-verifier` shorthand resolves through Bun's GitHub tarball path and is not reliable for private repos.

```bash
omp plugin install git+ssh://git@github.com/klondikemarlen/omp-verifier.git
```

If you previously installed from another source or need to force-refresh the installed version, reset the installed plugin first:

```bash
omp plugin uninstall omp-verifier
omp plugin install git+ssh://git@github.com/klondikemarlen/omp-verifier.git --force
```

The package version in `package.json` is release metadata, not the git ref. After install, verify the installed `package.json` version and file tree; the success line alone is not enough.

For local development, link the working tree so OMP loads your checkout:

```bash
omp plugin link ~/code/klondikemarlen/omp-verifier
```

Then restart OMP or run `/reload-plugins`.

## What this package provides

- `WATCHDOG.md` - aggressive advisor guidance for always-on verifier review.
- `agents/verifier.md` - generic verification agent.
- `agents/project-verifier.md` - generic project-aware verifier that reads local repo conventions first.
- `/verify-pr <repo> <pr-number>` - starts an evidence-first verification turn.
- `/verifier-info` - shows loaded commands/tools.
- `verify_pr_plan` - builds a Gold-first verification plan.
- `boot_app_plan` - derives PR-specific app boot env/ports; it does not start services.
- `format_pr_comment` - formats PASS/FAIL/BLOCKED PR evidence; it does not post to GitHub.

## Always-on advisor setup

OMP's built-in advisor is the closest supported runtime shape for "turn it on in settings and have it verify all code changes."

Add an advisor model and enable the advisor in `~/.omp/agent/config.yml` or a project-local `.omp/config.yml`:

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
  subagents: true
  syncBacklog: 1
```

`subagents: true` is optional; it extends OMP's built-in advisor to spawned task/eval subagents. It does not create a separate `omp-verifier` settings role.

Then add a project `WATCHDOG.md` that imports or copies the verifier rules. During local development, prefer the checkout path:

```markdown
@/path/to/omp-verifier/WATCHDOG.md

# Project verifier rules

- Add local setup, test commands, database rules, service names, and browser routes here.
- Keep rules that apply across projects generic; move those upstream to this repo.
```

After remote install verification proves the installed package is fresh, projects can import the installed copy instead:

```markdown
@~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md
```

Useful OMP docs:

- Subagents: https://omp.sh/docs/subagents
- Advisor and WATCHDOG: https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md
- Extensions: https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- Extension loading: https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md

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
   omp plugin uninstall omp-verifier
   npm run reinstall
   ```

   `npm run reinstall` uses the SSH Git repo with `--force`; the installed `package.json` version must match this repo's `package.json`.

6. Restart OMP or run `/reload-plugins`.
7. Confirm the installed package matches the pushed repo:

   ```bash
   cat ~/.omp/plugins/node_modules/omp-verifier/.bun-tag
   ls ~/.omp/plugins/node_modules/omp-verifier
   ls ~/.omp/plugins/node_modules/omp-verifier/agents
   ls ~/.omp/plugins/node_modules/omp-verifier/omp-plugin
   ```
   The installed tree should include `agents/project-verifier.md`, `CONCEPTS.md`, and `omp-plugin/index.js`. If it still shows an old commit or `agents/wrap-verifier.md`, remote install verification failed; use `omp plugin link "$PWD"` for local development and investigate the OMP/Bun git install pin before release.

8. Confirm the installed plugin loads:

   ```text
   /verifier-info
   ```

## Concepts

See [CONCEPTS.md](./CONCEPTS.md) for the verifier workflow, install lessons, release flow, and current runtime limits.
