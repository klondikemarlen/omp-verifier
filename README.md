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

The global file imports this plugin's shared verifier guidance into the default advisor. It does not edit your global `config.yml`; keep `advisor.enabled` and `modelRoles.advisor` configured through OMP settings.

Re-running the install migrates only verifier-generated global wrappers after updating this plugin:

```text
/verifier install global
```

Remove the generated global wrapper:

```text
/verifier uninstall global
```

In OMP's advisor configuration UI, select `Scope: project` when you want to view or edit project-level advisors after installing the global verifier. The global install lives at user scope; project-specific advisors/rules appear under project scope.

## Install verifier into one project

In the downstream repo:

```text
/verifier install
```

Typing `/verifier ` in OMP shows subcommand completions for `install`, `uninstall`, and `status`.

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

`WATCHDOG.yml` configures the default advisor with verifier guidance:
```yaml
instructions: |
  Everyone: keep advice concrete, evidence-first, and non-repetitive.

advisors:
  - name: default
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

Edit the downstream repo's `WATCHDOG.yml` to add project-specific commands, services, database details, browser routes, and local definitions of done.

Keep generic verifier behavior in this repo's `WATCHDOG.md`.

Re-running the install migrates verifier-generated `WATCHDOG.yml` files without touching existing `.omp/config.yml`:

```text
/verifier install
```

Install preserves customized `WATCHDOG.yml` files; merge the verifier advisor manually if you keep local rules in that file.

## Uninstall verifier from a project

```text
/verifier uninstall
```

This removes only verifier-generated files:

- generated `WATCHDOG.yml` is removed;
- customized `WATCHDOG.yml` is preserved;
- generated `.omp/config.yml` is removed;
- customized `.omp/config.yml` is preserved.

Use `global` with install or uninstall to target the user-level `WATCHDOG.yml` instead of the current repo; `local` is the default.

## Verify plugin load

```text
/verifier status
```

Bare `/verifier` shows the same status.

Expected:

```text
Verifier status:
project: /path/to/repo
active agent dir: ~/.omp/agent
verifier source: global
project override: none
advisor: global enabled, model configured; project config absent
rules: generated

files:
  global WATCHDOG.yml: generated — ~/.omp/agent/WATCHDOG.yml
  global config.yml: exists; advisor enabled; modelRoles.advisor configured — ~/.omp/agent/config.yml
  project WATCHDOG.yml: absent — /path/to/repo/WATCHDOG.yml
  project .omp/config.yml: absent — /path/to/repo/.omp/config.yml
```

## Release checklist

1. Update code, docs, tests, `package.json` version, and `CHANGELOG.md` on a feature branch.
2. Run `npm run release:check`.
3. Commit with the style in `COMMITTING.md`.
4. Push the branch, open a linked PR, review it, and merge it to `main`.
5. Tag the merged version with `v<package.json version>` and push the tag.
6. Reinstall from the remote source.
7. Confirm installed `.bun-tag`, `package.json` version, and `/verifier status`.

See [CONCEPTS.md](./CONCEPTS.md) for design notes and install lessons.
