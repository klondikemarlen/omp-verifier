# OMP Verifier

An OMP plugin that adds a focused `verifier` advisor after OMP's stock `default` advisor.

## Scope

The plugin does five things:

1. Preserves or restores the stock `default` advisor entry.
2. Adds a marked `verifier` advisor entry immediately after it.
3. Syncs verifier-only evidence guidance into the active agent directory.
4. Shows or removes its marked advisor block with `/verifier`.
5. Discovers installed verification manifests, runs matching `pathTriggers` automatically after changed turns, and retains explicit manual runs.

It does not configure models, tools, OMP runtime settings, task agents, GitHub workflows, browser checks, or generic code review. Verification manifests are explicit package-owned checks; they are not inferred from arbitrary tools or maintainer test filenames.

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


The plugin copies its shipped guidance to `<agent-dir>/verifier/WATCHDOG.md` on every setup. The roster imports that agent-owned generated file, matching OMP Learner's ownership model. Reinstall refreshes the copy; put custom requirements in project `WATCHDOG.yml`, not this generated file.

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
/verifier checks
/verifier verify
/verifier verify <check-id...>
/verifier uninstall
```

`/verifier checks` lists valid checks declared by installed plugin manifests. `/verifier verify` runs all discovered checks; named IDs run only the requested checks. Results are reported as `PASS`, `FAIL`, or `BLOCKED`.

After a changed agent turn in a Git worktree, every installed check with a matching `pathTriggers` pattern runs automatically. Its result identifies the changed path and matched trigger. Checks without `pathTriggers`, explicitly named checks, and `/verifier verify` retain their manual behavior. Scoped suppressions are reported as `SUPPRESSED`; they are not PASS evidence.

With no compatible manifests installed, `checks` reports `none installed` and `verify` reports `BLOCKED`. Existing advisor setup and cleanup remain independent of the optional check surface.

## Verification manifests

An installed OMP plugin can opt in through `package.json`:

```json
{
  "omp": {
    "extensions": ["./omp-plugin/index.js"],
    "verifications": [{
      "id": "publisher:check-id",
      "label": "Human label",
      "description": "What the check proves",
      "entry": "./verifications/check-id.mjs",
      "pathTriggers": ["tests/**", "**/*.test.js"],
      "timeoutMs": 30000
    }]
  }
}
```

Each entry must be a package-relative `.mjs` module that writes one JSON result with `PASS`, `FAIL`, or `BLOCKED`. A `FAIL` result may exit with code `1`; the verifier preserves that reported failure. The package must expose an `omp.extensions` or `pi.extensions` entry; the verifier invokes entries without a shell in the active project directory. `pathTriggers` is an optional non-empty array of project-relative glob patterns; only declared matching checks run automatically. Invalid manifests, traversal, duplicate IDs, timeouts, malformed output, missing entries, and other non-zero exits fail closed as `BLOCKED`; model-supplied commands are never accepted.

`/verifier verify` does not scan remote repositories or execute arbitrary `verify-*` files. Installed plugin code remains trusted; the manifest is a discovery convention, not a sandbox.

### Scoped automatic-check suppression

Use `.omp-verifier.json` at the Git root or beneath the affected subtree. Its `path` is relative to that file and must not match the entire project:

```json
{
  "suppressions": [{
    "id": "publisher:check-id",
    "path": "legacy-tests/**",
    "reason": "The vendor fixture is intentionally outside this check's contract.",
    "expires": "2026-12-31"
  }]
}
```

Each suppression requires a verification id, bounded path, and non-empty reason. `expires` is optional, but an invalid or expired entry is `BLOCKED` rather than silently disabling a check. A missing `.omp-verifier.json` has no effect.

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
