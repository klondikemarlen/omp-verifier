# OMP Verifier

Installable OMP plugin that injects one evidence-first verifier as an always-on advisor.

## Scope

Only these features belong here:

1. Install the plugin.
2. Auto-install lightweight verifier advisor guidance for the active OMP agent.
   It is named `verifier`, so the regular `default` advisor and independent advisors such as `learner` remain available.
3. Let each downstream repo customize local rules in `WATCHDOG.local.md`.
4. Let upstream verifier guidance change here and flow downstream after reinstall.

5. Flag a direct, observed correctness, security, or data-loss risk with a concrete reason and smallest corrective action or check.

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

`WATCHDOG.yml` refreshes the verifier-owned `default` advisor while preserving independently installed advisors.
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

Edit `WATCHDOG.local.md` in the downstream repo when a project needs specific commands, services, database details, browser routes, local definitions of done, or human-readable code rules. The verifier no longer scaffolds project-local files; keeping that file explicit avoids another command surface.

The file can use this shape; replace placeholders with real local commands, rules, and Gold examples:
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

## Human-readable code

- Enforced style rules: <formatter, linter, static-analysis command, or local style doc>
- Gold examples: <one or two relevant paths that demonstrate the desired shape>
- Conditional/control-flow rule: <e.g. prefer guard clauses and named intermediate values over nested ternaries>
- Decomposition rule: <e.g. keep each semantic decision or transformation in its own statement>
- Transformation rule: <e.g. split layered map/filter/reduce/callback chains when intermediate meaning is not obvious>
- Style concern evidence: <changed-file lines plus the local rule or Gold example>

## Local PASS / FAIL / BLOCKED

- PASS: observed evidence proves the changed behavior or invariant.
- FAIL: observed evidence shows a regression, broken invariant, or wrong behavior.
- BLOCKED: a required command, service, seed, credential, or route is unavailable.
```

Start with enforced rules and one nearby Gold example. Add a local rule only after the same review correction recurs; state the readability risk and a narrow exception rather than collecting snippets.

Keep generic verifier behavior in this repo's `WATCHDOG.md`.
Shared guidance also flags direct correctness, security, or data-loss risks visible in changed code. It does not replace downstream semantic-style rules or invent hypothetical concerns.

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
