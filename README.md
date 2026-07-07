# OMP Verifier

Installable OMP plugin that injects one evidence-first verifier as an always-on advisor.

## Scope

Only these features belong here:

1. Install the plugin.
2. Install/uninstall verifier advisor injection in a target repo.
3. Let each downstream repo customize local rules in `WATCHDOG.yml`.
4. Let upstream verifier guidance change here and flow downstream after reinstall.

Not included: PR checkout, app booting, GitHub comments, verifier task agents, planning tools, or custom runtimes.

## Install plugin

Private GitHub repos must use SSH:

```bash
omp plugin install git+ssh://git@github.com/klondikemarlen/omp-verifier.git#<commit>
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

Use this when you want verifier behavior in every OMP session:

```text
/verifier install global
```

```text
<active agent dir>/WATCHDOG.yml
```

By default that is `~/.omp/agent/WATCHDOG.yml`; `PI_CODING_AGENT_DIR` is respected when your active agent dir is relocated.

The global file imports this plugin's shared verifier guidance and adds a second advisor named `Verifier`. It does not edit your global `config.yml`; keep `advisor.enabled` and `modelRoles.advisor` configured through OMP settings.

Re-running the install refreshes the global wrapper after updating this plugin:

```text
/verifier install global
```

Remove the generated global wrapper:

```text
/verifier uninstall global
```

## Install verifier into one project

In the downstream repo:

```text
/verifier install
```

Typing `/verifier ` in OMP shows subcommand completions for `install`, `uninstall`, and `info`.

This creates:

```text
.omp/config.yml
WATCHDOG.yml
```

`.omp/config.yml` is only created when absent. It enables OMP's built-in advisor for this project without changing your configured default advisor model:

```yaml
advisor:
  enabled: true
  subagents: true
  syncBacklog: 1
```

`WATCHDOG.yml` keeps the original default advisor and adds a second always-on verifier advisor:
```yaml
instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
  - name: default

  - name: Verifier
    tools: [read, grep, glob]
    instructions: |
      @~/.omp/plugins/node_modules/omp-verifier/WATCHDOG.md

      You are the always-on verifier for this session.
      Review completed code-change turns as untrusted until evidence proves them.
      Raise a blocker when work is called done without observed evidence.
      Raise a concern when checks are too broad, too narrow, or ignore local setup.
      Stay silent when the evidence is sufficient.

      Project-specific rules can live in downstream WATCHDOG files: setup commands,
      test commands, database/service details, browser routes, and "done means" checks.
```

Restart OMP from that repo or run:

```text
/advisor on
```

## Customize downstream

Edit the downstream repo's `WATCHDOG.yml` below the upstream import. Keep project-specific commands, services, database details, browser routes, and local definitions of done there.

Keep generic verifier behavior in this repo's `WATCHDOG.md`.

Re-running the install refreshes the downstream wrapper without touching existing `.omp/config.yml`:

```text
/verifier install
```

Install always replaces only the targeted `WATCHDOG.yml`. Existing `.omp/config.yml` is preserved; merge advisor settings manually if that file already exists.

## Uninstall verifier from a project

```text
/verifier uninstall
```

This removes files only when they still match the generated verifier content:

- generated `WATCHDOG.yml` is removed;
- generated `.omp/config.yml` is removed;
- customized files are kept with a message to remove the verifier block manually.

To remove a customized `WATCHDOG.yml` anyway:

```text
/verifier uninstall --force
```

Even with `--force`, customized `.omp/config.yml` is preserved. Use `global` with install or uninstall to target the user-level `WATCHDOG.yml` instead of the current repo; `local` is the default.

## Verify plugin load

```text
/verifier info
```

Expected:

```text
Verifier: /verifier install [local|global] | /verifier uninstall [local|global] [--force] | /verifier info
```

## Release checklist

1. Update code, docs, tests, `package.json` version, and `CHANGELOG.md`.
2. Run `npm run release:check`.
3. Commit with the style in `COMMITTING.md`.
4. Push `main`.
5. Tag the committed version with `v<package.json version>` and push the tag.
6. Run `omp plugin uninstall omp-verifier && npm run reinstall`.
7. Confirm installed `.bun-tag`, `package.json` version, and `/verifier info`.

See [CONCEPTS.md](./CONCEPTS.md) for design notes and install lessons.
