# OMP Verifier

An OMP plugin that adds a focused `verifier` advisor after OMP's stock `default` advisor.

## Scope

The plugin does five things:

1. Preserves or restores the stock `default` advisor entry.
2. Adds a marked `verifier` advisor entry immediately after it.
3. Syncs verifier-only evidence guidance into the active agent directory.
4. Shows or removes its marked advisor block with `/verifier`.
5. Exposes deterministic verification manifests to explicit commands and to the verifier advisor after changed turns.

It does not configure advisor models, task agents, GitHub workflows, browser checks, or generic code review. The generated verifier advisor receives only `bash`, which it uses to run the packaged automatic-verification coordinator. Verification manifests are explicit package-owned checks; they are not inferred from arbitrary tools or maintainer test filenames.

## Install

```bash
omp plugin install github:klondikemarlen/omp-verifier
```

On the next OMP session, the user-level roster is reconciled to this shape while preserving other advisors:

```yaml
advisors:
  - name: default

  # omp-verifier: advisor begin
  - name: verifier
    tools: [bash]
    instructions: |
      @/home/<user>/.omp/agent/verifier/WATCHDOG.md
  # omp-verifier: advisor end
```

The plugin copies its shipped guidance to `<agent-dir>/verifier/WATCHDOG.md` on every setup. During that copy it substitutes the coordinator path derived from the installed package, so profiles and non-default install roots do not depend on `~/.omp`. The roster imports that agent-owned generated file. Reinstall refreshes the copy; put custom requirements in project `WATCHDOG.yml`, not this generated file.

The empty `default` entry uses OMP's stock advisor behavior. The verifier advisor runs matching automatic checks and stays silent for `PASS`, `SUPPRESSED`, or no results. For `FAIL` or `BLOCKED`, it emits standard OMP `blocker` advice with evidence and the smallest next check.

## Project-specific verifier requirements

Add a project `WATCHDOG.yml` entry named `verifier` when a repository needs a requirement beyond the default advisor:

```yaml
advisors:
  - name: verifier
    tools: [bash]
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

After a changed agent turn in a Git worktree, the verifier advisor passes only the project-relative paths changed by that turn to the packaged `automatic` coordinator. It does not select from unrelated uncommitted paths from earlier turns. Every installed check with a matching `pathTriggers` pattern returns its changed path and matched trigger in structured JSON. The advisor emits no advice for `PASS`, `SUPPRESSED`, or no results; `FAIL` and `BLOCKED` become standard OMP blocker advice that resumes or steers the primary agent. Checks without `pathTriggers` and `/verifier verify` remain manual. `automatic --worktree` remains available only for an explicitly requested full working-tree check.

With no compatible manifests installed, `checks` reports `none installed`, `verify` reports `BLOCKED`, and the automatic coordinator returns an empty array. Existing advisor setup and cleanup remain independent of the optional check surface.

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

Each entry must be a package-relative `.mjs` module that writes one JSON result with `PASS`, `FAIL`, or `BLOCKED`. A `FAIL` result may exit with code `1`; the verifier preserves that reported failure. Automatic entries receive `OMP_VERIFIER_CHANGED_PATHS` as a JSON array of their matching project-relative paths; manual `/verifier verify` removes it. The package must expose an `omp.extensions` or `pi.extensions` entry; the verifier invokes entries without a shell in the active project directory. `pathTriggers` is an optional non-empty array of project-relative glob patterns; only declared matching checks run automatically. Invalid manifests, traversal, duplicate IDs, timeouts, malformed output, missing entries, and other non-zero exits fail closed as `BLOCKED`; model-supplied commands are never accepted.

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

## Development and release

Every release uses the same workflow:

1. Create or update an issue with acceptance criteria and learner coverage.
2. Work on an issue-named branch and open a linked draft pull request.
3. Self-review the complete PR diff.
4. Run focused QA plus `npm run release:check`.
5. Record QA and self-review status in the PR; resolve actionable feedback.
6. Mark the PR ready only after required checks pass, then merge with a merge commit.
7. Fetch and prune, return to synchronized `main`, and delete only the merged agent-owned branch.
8. Run `npm run reinstall`, verify the installed version in a fresh OMP process, and exercise `/verifier` completion and the changed behavior.

For advisor-correction releases, QA with a temporary deterministic failing manifest:

1. Check `/advisor status`; the `verifier` advisor must be enabled with a resolved model. `[no model]` blocks correction claims.
2. Trigger a changed path and run the coordinator from the packed or remotely installed artifact. Observe structured `FAIL` or `BLOCKED` JSON and exit `1`.
3. Let the primary agent finish. Observe `<advisory advisor="verifier" severity="blocker">` with the check id, evidence, and next check.
4. Verify the primary agent resumes or is steered, applies remediation, and the next coordinator run returns `PASS` or no applicable results.
5. Verify `PASS`, `SUPPRESSED`, and no results inject no advice.
6. If remediation remains incomplete, wait through `advisor.immuneTurns` and verify the repeated failure eventually re-enters the correction loop.

Do not claim publish, install, or advisor correction without observed evidence.
