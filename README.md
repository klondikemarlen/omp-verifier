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

1. Capture the user story and acceptance criteria.
2. Keep the implementation in the smallest command/runtime surface that satisfies it.
3. Update docs, tests, `package.json` version, and `CHANGELOG.md`.
4. Run `npm run release:check`.
5. Commit, push `main`, tag the package version, reinstall from the remote source, and verify the installed package behavior.


## Install verifier into a project

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

      You are the always-on verifier for this project.
      Review completed code-change turns as untrusted until evidence proves them.
      Raise a blocker when work is called done without observed evidence.
      Raise a concern when checks are too broad, too narrow, or ignore local setup.
      Stay silent when the evidence is sufficient.

      Downstream project rules belong below this import: setup commands, test commands,
      database/service details, browser routes, and project-specific "done means" checks.
```

Restart OMP from that repo or run:

```text
/advisor on
```

## Customize downstream

Edit the downstream repo's `WATCHDOG.yml` below the upstream import. Keep project-specific commands, services, database details, browser routes, and local definitions of done there.

Keep generic verifier behavior in this repo's `WATCHDOG.md`.

Refresh the downstream wrapper without touching existing `.omp/config.yml`:

```text
/verifier install --force
```

`--force` replaces only `WATCHDOG.yml`. Existing `.omp/config.yml` is preserved; merge advisor settings manually if that file already exists.

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

Even with `--force`, customized `.omp/config.yml` is preserved.

## Verify plugin load

```text
/verifier info
```

Expected:

```text
Verifier: /verifier install [--force] | /verifier uninstall [--force] | /verifier info
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
