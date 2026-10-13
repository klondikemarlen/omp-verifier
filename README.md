# OMP Verifier

An OMP plugin that uses a focused `verifier` advisor to select and execute programmatic checks after OMP's stock `default` advisor.

## Documentation

- [Documentation Map](docs/index.md) — product, release, and reference-guide routing.
- [Verifier Concepts Reference](docs/references/verifier-concepts-reference.md) — advisor lifecycle and verification contracts.

## Scope

The plugin does five things:

1. Preserves or restores the stock `default` advisor entry.
2. Adds a marked `verifier` advisor entry immediately after it.
3. Syncs verifier-only evidence guidance into the active agent directory.
4. Shows or removes its marked advisor block with `/verifier`.
5. Exposes deterministic verification manifests to explicit commands and to the verifier model after changed turns.

The model decides which explicit checks apply and runs them; its feedback is verification results, not general advice. The stock advisor retains code review. Verifier does not configure advisor models, task agents, GitHub workflows, browser checks, or generic code review. The generated verifier advisor receives only `bash`, which it uses to run the packaged coordinator or a project's explicit narrow check. Verification manifests are package-owned checks, not inferred from arbitrary tools or maintainer test filenames.

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

The plugin copies its shipped guidance to `<agent-dir>/verifier/WATCHDOG.md` on every setup. During that copy it substitutes the shell-quoted coordinator path derived from the installed package, so profiles and non-default install roots do not depend on `~/.omp` or expand shell syntax in their paths. The roster imports that agent-owned generated file. Reinstall refreshes the copy; put custom requirements in project `WATCHDOG.yml`, not this generated file.

The empty `default` entry uses OMP's stock advisor behavior. The verifier prompt specializes its model as a check selector/executor, not a reviewer. It runs applicable checks and stays silent for `PASS`, `SUPPRESSED`, or no results. For `FAIL` and `BLOCKED`, it passes only the failing JSON result objects unchanged to native `advise` with severity `blocker`; `advise` is delivery transport, not permission to add recommendations, progress notes, or broader review. The UI still labels that native channel “Advisor.” Result-only output and silence are prompt contracts, not runtime-enforced admission. Historical OMP 18.8.9 QA delivered a no-action `nit` despite a prior stricter silence prompt; see [Advisor Silence: Plugin Policy and QA](docs/references/verifier-concepts-reference.md#advisor-silence-plugin-policy-and-qa).

## Project-specific verifier requirements

Add a project `WATCHDOG.yml` entry named `verifier` when a repository needs a requirement beyond the default advisor:

```yaml
advisors:
  - name: verifier
    tools: [bash]
    instructions: |
      @/home/<user>/.omp/agent/verifier/WATCHDOG.md

      - Check id project:database-migrations. When a database migration changes, run `npm run db:verify`; Gold is current migration status, evidenced by exit 0 and the command's status output.
```

Each requirement names its trigger, check id, Gold condition, executable narrow check, and PASS evidence. The verifier must execute the applicable check; merely proposing a future check does not establish verification. It ignores placeholders and generic guidance. Commands without structured output are classified from the observed exit/output and the explicit Gold condition using the same result shape.

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

After a changed agent turn in a Git worktree, the verifier model passes only the project-relative paths changed by that turn to the packaged `automatic` coordinator. It does not select unrelated uncommitted paths from earlier turns. Every installed check with a matching `pathTriggers` pattern returns its changed path and matched trigger in structured JSON. `PASS`, `SUPPRESSED`, and no results stay silent; only actual `FAIL` and `BLOCKED` rows are delivered as JSON through the standard OMP blocker channel. No paraphrased advice or successful rows are appended. Checks without `pathTriggers` remain manual; the model selects them only for an explicit applicable requirement. `automatic --worktree` is only for an explicitly requested full working-tree check.

With no compatible manifests installed, `checks` reports `none installed`, `verify` reports `BLOCKED`, and the automatic coordinator returns an empty array. Existing advisor setup and cleanup remain independent of the optional check surface.

The `bash`-only advisor can discover and run named checks using the packaged CLI:

```text
omp-verifier checks
omp-verifier verify <check-id...>
omp-verifier automatic <changed-path...>
```

`checks` writes `{ "checks": [...], "blockedResults": [...] }`; discovery never executes checks. `verify` writes the same JSON result array as `automatic` and supports all checks when explicitly invoked without ids. Both execution commands exit `1` for any `FAIL`/`BLOCKED`, otherwise `0`; invalid usage exits `2`. Named verification shares its runner with `/verifier verify`. The generated prompt uses the installed CLI's absolute path rather than requiring the executable on `PATH`.

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
3. Let the primary agent finish. Observe `<advisory advisor="verifier" severity="blocker">`; parse its note as a JSON array and compare its FAIL/BLOCKED objects with the actual coordinator output. No successful rows, invented fields, or extra commentary may appear.
4. Verify the primary agent resumes or is steered, applies remediation, and the next coordinator run returns `PASS` or no applicable results.
5. Verify `PASS`, `SUPPRESSED`, and no results inject no advice.
6. If remediation remains incomplete, wait through `advisor.immuneTurns` and verify the repeated failure eventually re-enters the correction loop.

Do not claim publish, install, or advisor correction without observed evidence.
