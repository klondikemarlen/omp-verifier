# OMP Verifier

An OMP plugin that adds a focused `verifier` advisor after OMP's stock `default` advisor.

## Scope

The plugin does only four things:

1. Preserves or restores the stock `default` advisor entry.
2. Adds a marked `verifier` advisor entry immediately after it.
3. Syncs verifier-only evidence guidance into the active agent directory.
4. Shows or removes its marked advisor block with `/verifier`.

It does not configure models, tools, OMP runtime settings, task agents, GitHub workflows, browser checks, style rules, or generic code review.

## Install

```bash
omp plugin install github:klondikemarlen/omp-verifier#<tag-or-commit>
```

On the next OMP session, the user-level roster is reconciled to this shape while preserving other advisors:

```yaml
advisors:
  - name: default

  # omp-verifier: advisor begin
  - name: verifier
    instructions: |
      @/home/<user>/.omp/agent/verifier/WATCHDOG.md
  # omp-verifier: advisor end
```


The plugin copies its shipped guidance to `<agent-dir>/verifier/WATCHDOG.md` on setup. The roster imports that agent-owned file, matching OMP Learner's ownership model. Reinstall refreshes the copy; uninstall removes it only when it is unchanged.

The empty `default` entry uses OMP's stock advisor behavior. The verifier block adds only the plugin's explicit-requirement evidence review.

## Project-specific verifier requirements

Add a project `WATCHDOG.yml` entry named `verifier` when a repository needs a requirement beyond the default advisor:

```yaml
advisors:
  - name: verifier
    instructions: |
      @/home/<user>/.omp/agent/verifier/WATCHDOG.md

      - When a database migration changes: run `npm run db:verify`; PASS when migration status is current.
```

Each requirement names its trigger, Gold condition, narrow check, and PASS evidence. The verifier ignores placeholders and generic guidance.

## Commands

```text
/verifier
/verifier status
/verifier uninstall
```

`/verifier uninstall` removes only the marked verifier block. It leaves `default` and independent advisors such as `learner` in place.

Use `/advisor status` for OMP runtime state.

## Development

```bash
npm run release:check
```

After a release, reinstall the remote plugin:

```bash
npm run reinstall
```
