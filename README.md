# OMP Verifier

Installable OMP plugin that injects one evidence-first verifier as an always-on advisor.

## Scope

Only these features belong here:

1. Install the plugin.
2. Auto-install a named `verifier` advisor for explicit downstream verification-policy checks.
   It does not create or modify the host-owned default role or independent advisors such as `learner`.
3. Let each downstream repo customize local rules in `WATCHDOG.local.md`.
4. Let upstream verifier guidance change here and flow downstream after reinstall.

Not included: PR checkout, app booting, GitHub comments, verifier task agents, planning tools, or custom runtimes.

## Install plugin

Install the public GitHub release:

```bash
omp plugin install github:klondikemarlen/omp-verifier#<tag-or-commit>
```

For local development, link this checkout:

```bash
omp plugin link ~/code/klondikemarlen/omp-verifier
```

Then restart OMP or run `/reload-plugins`.

## Feature workflow

For user-facing feature work, follow the release pattern from Marlen's other OMP projects:

1. Capture the user story and acceptance criteria in a GitHub issue.
2. Create a feature branch linked to the issue.
3. Keep the implementation in the smallest command/runtime surface that satisfies it.
4. Update docs, tests, `package.json` version, and `CHANGELOG.md`.
5. Run `npm run release:check` locally; the GitHub Actions `Release Check` must also pass on the pull request.
6. Commit, push the branch, and open a pull request linked to the issue.
7. Review the PR from the user's perspective and fix any findings.
8. Merge the PR to `main`.
9. Tag the package version, reinstall from the remote source, and verify the installed package behavior.


## Install verifier globally

Install the plugin:

```bash
omp plugin install github:klondikemarlen/omp-verifier
```

Loading OMP now automatically creates or refreshes the user-level verifier files:

```text
~/.omp/agent/WATCHDOG.yml
~/.omp/agent/WATCHDOG.local.md
```

`WATCHDOG.yml` owns only a named `verifier` advisor and imports its shipped and local policy guidance.
`WATCHDOG.local.md` is generated only when absent or previously generated; customized local guidance is preserved.

The plugin owns verifier guidance only. Configure advisor tools, model, and runtime behavior in local OMP configuration.

Manual verifier commands:

```text
/verifier
/verifier status
/verifier uninstall
```

OMP's plugin-uninstall lifecycle hook removes generated files automatically when host support is available; track can1357/oh-my-pi#5531. Until then, run `/verifier uninstall` before removing the plugin. It removes only generated verifier files, preserves customized files, and tells you to run `omp plugin uninstall omp-verifier`.

Typing `/verifier ` shows completions for `status` and `uninstall`.

Restart OMP after first install if the advisor is not already active, or run:

```text
/advisor on
```

## Customize downstream

`WATCHDOG.local.md` contains only explicit verifier requirements. Add a rule when a project-specific condition needs evidence beyond OMP's generic advisor review:

```markdown
# Local Verifier Rules

- When a database migration changes: run `npm run db:verify`; PASS when the migration status is current.
- Before a production release: run `npm run release:check`; PASS when it exits successfully.
```

Each rule must name its trigger, behavior or invariant, narrow check, and PASS evidence. The verifier ignores placeholders and generic guidance; keep generic code-quality, strategy, and risk review with OMP's host advisor.

The verifier setup is refreshed automatically when the plugin loads.

## Uninstall verifier

Before removing the plugin, run:

```text
/verifier uninstall
```

It safely removes generated user-level files while preserving customization:

- a fully generated `~/.omp/agent/WATCHDOG.yml` is removed;
- when that roster also has independent advisors, only the verifier advisor is removed;
- a customized `~/.omp/agent/WATCHDOG.yml` is preserved;
- generated `~/.omp/agent/WATCHDOG.local.md` is removed;
- customized `~/.omp/agent/WATCHDOG.local.md` is preserved.

Then run:

```bash
omp plugin uninstall omp-verifier
```

On hosts that support plugin uninstall lifecycle hooks, `omp plugin uninstall omp-verifier` runs the same safe cleanup automatically. Project-local install and scaffolding commands remain unsupported.

## Verify plugin load

```text
/verifier status
```

Bare `/verifier` shows the same status.

Expected:

```text
Verifier status:
plugin version: <installed plugin version>
static command metadata: global auto-install enabled
runtime advisor state: not directly observable from plugin command; file/config checks below are readiness evidence

project: /path/to/repo
active agent dir: ~/.omp/agent
verifier source: global
project override: none
advisor: global enabled, model configured; project config absent
rules: generated

files:
  global WATCHDOG.yml: generated — ~/.omp/agent/WATCHDOG.yml
  global config.yml: exists; advisor enabled; modelRoles.advisor configured — ~/.omp/agent/config.yml
  global WATCHDOG.local.md: generated — ~/.omp/agent/WATCHDOG.local.md
  project WATCHDOG.yml: absent — /path/to/repo/WATCHDOG.yml
  project .omp/config.yml: absent — /path/to/repo/.omp/config.yml
  project WATCHDOG.local.md: absent — /path/to/repo/WATCHDOG.local.md
```

## Release checklist

1. Update code, docs, tests, `package.json` version, and `CHANGELOG.md` on a feature branch.
2. Run `npm run release:check` locally and confirm the pull request's GitHub Actions `Release Check` passes.
3. Commit with the style in `COMMITTING.md`.
4. Push the branch, open a linked PR, review it, and merge it to `main`.
5. Tag the merged version with `v<package.json version>` and push the tag.
6. Reinstall from the public GitHub source with `npm run reinstall`.
7. Confirm installed `.bun-tag`, `package.json` version, and `/verifier status`.

See [CONCEPTS.md](./CONCEPTS.md) for design notes and install lessons.
