# OMP Verifier

Installable OMP plugin that injects one evidence-first verifier as an always-on advisor.

## Scope

Only these features belong here:

1. Install the plugin.
2. Install/uninstall verifier advisor injection in a target repo.
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
5. Run `npm run release:check`.
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

`WATCHDOG.yml` is verifier-owned and refreshed like `/verifier install global replace`.
`WATCHDOG.local.md` is generated only when absent or previously generated; customized local guidance is preserved.

The manual command is still available, but it targets the same global setup:

```text
/verifier install
```

`global` and `replace` are accepted for old muscle memory:

```text
/verifier install global replace
```

Remove generated global verifier files:

```text
/verifier uninstall
```

Automatic cleanup on `omp plugin uninstall omp-verifier` is declared through OMP's plugin uninstall lifecycle hook and becomes active only after a future OMP release ships that capability; track can1357/oh-my-pi#5531. Until then, run `/verifier uninstall` before `omp plugin uninstall omp-verifier` when you want generated files cleaned up.

In OMP's advisor configuration UI, select `Scope: project` when you want to view or edit project-level advisors after installing the global verifier. The global install lives at user scope; project-specific advisors/rules appear under project scope.

Typing `/verifier ` in OMP shows subcommand completions for `install`, `init-local`, `uninstall`, and `status`.

Restart OMP after first install if the advisor is not already active, or run:

```text
/advisor on
```

## Customize downstream

Edit the downstream repo's `WATCHDOG.local.md` to add project-specific commands, services, database details, browser routes, and local definitions of done.

To create only the local guidance file without reinstalling advisor wrappers:

```text
/verifier init-local
```

Use `replace` only when you intentionally want to overwrite customized local guidance:

```text
/verifier init-local replace
```

The generated file uses this shape; replace placeholders with real local commands:

```markdown
# Local Verifier Rules

Replace placeholders with commands from this repo. Keep uncertain entries as suggestions.

## Project setup

- Install dependencies: <repo command>
- Start services: <repo command for database/cache/queue/app server>
- Apply migrations: <repo command>
- Seed data: <repo command or fixture/account name>

## Targeted checks

- Unit or API change: <focused test command>
- Typecheck/build: <typecheck or build command>
- Migration change: <migration verification command>

## Browser/UI smoke

- Route: <local route>
- Action: <user-visible flow>
- Expected evidence: <visible label, URL, screenshot path, or state>

## High-risk areas

- Auth, billing, migrations, permissions, admin flows, and data deletion require focused checks.
- Do not approve these from compile/type checks alone.

## Local PASS / FAIL / BLOCKED

- PASS: observed evidence proves the changed behavior or invariant.
- FAIL: observed evidence shows a regression, broken invariant, or wrong behavior.
- BLOCKED: a required command, service, seed, credential, or route is unavailable.
```

Keep generic verifier behavior in this repo's `WATCHDOG.md`.

Re-running install refreshes the verifier-generated global `WATCHDOG.yml` wrapper without touching customized `WATCHDOG.local.md` guidance:

```text
/verifier install
```

## Uninstall verifier

```text
/verifier uninstall
```

This removes generated user-level verifier files:

- generated `~/.omp/agent/WATCHDOG.yml` is removed;
- customized `~/.omp/agent/WATCHDOG.yml` is preserved;
- generated `~/.omp/agent/WATCHDOG.local.md` is removed;
- customized `~/.omp/agent/WATCHDOG.local.md` is preserved.

Project-local install/uninstall is intentionally no longer supported; use `/verifier init-local [replace]` only to scaffold downstream repo guidance.

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
2. Run `npm run release:check`.
3. Commit with the style in `COMMITTING.md`.
4. Push the branch, open a linked PR, review it, and merge it to `main`.
5. Tag the merged version with `v<package.json version>` and push the tag.
6. Reinstall from the public GitHub source with `npm run reinstall`.
7. Confirm installed `.bun-tag`, `package.json` version, and `/verifier status`.

See [CONCEPTS.md](./CONCEPTS.md) for design notes and install lessons.
