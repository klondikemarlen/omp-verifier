# OMP Verifier

An OMP plugin that uses a focused `verifier` advisor to execute declared checks and supplied standards contracts after OMP's stock `default` advisor.

## Documentation

- [Documentation Map](docs/index.md) — product, release, and reference-guide routing.
- [Verifier Concepts Reference](docs/references/verifier-concepts-reference.md) — advisor lifecycle and verification contracts.

## Scope

The plugin does five things:

1. Preserves or restores the stock `default` advisor entry.
2. Adds a marked `verifier` advisor entry immediately after it.
3. Syncs verifier-only evidence guidance into the active agent directory.
4. Shows or removes its marked advisor block with `/verifier`.
5. Exposes deterministic checks and explicit agentic standards contracts to commands and the existing verifier advisor.

The model selects applicable checks and evaluates supported supplied rubrics; its feedback is verification results, not general advice. The stock advisor retains generic code review. Verifier does not configure advisor models, task agents, GitHub workflows, browser checks, or generic code review. The generated verifier advisor receives only `bash`, which it uses to run the packaged coordinator or a project's explicit narrow check. Verification contracts are package-owned, not inferred from arbitrary prose, tools, or maintainer test filenames.

Verifier checks code adherence, not whether a human correction has been recorded. Learner owns that coverage decision; the policy owner maintains the tracked rule and its supplied verification contract. See [ownership boundaries](docs/references/verifier-concepts-reference.md#ownership-boundaries) for the distinction and a correction/recheck example.

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

The plugin copies its shipped guidance to `<agent-dir>/verifier/WATCHDOG.md` on every setup. During that copy it substitutes the shell-quoted coordinator path derived from the installed package, so profiles and non-default install roots do not depend on `~/.omp` or expand shell syntax in their paths. The roster imports that agent-owned generated file. Extension registration awaits reconciliation before the first advisor import; session start also reconciles the active profile. Put custom requirements in project `WATCHDOG.yml`, not this generated file.

The empty `default` entry uses OMP's stock advisor behavior. The verifier prompt specializes its model as a check selector/executor, not a reviewer. It runs applicable checks and stays silent for `PASS`, `SUPPRESSED`, or no results. For `FAIL` and `BLOCKED`, it requests the coordinator's failure-only text reporter and passes that readable output unchanged to native `advise` with severity `blocker`; `advise` is delivery transport, not permission to add recommendations, progress notes, or broader review. The UI still labels that native channel “Advisor.” Result-only output and silence are prompt contracts, not runtime-enforced admission. Historical OMP 18.8.9 QA delivered a no-action `nit` despite a prior stricter silence prompt; see [Advisor Silence: Plugin Policy and QA](docs/references/verifier-concepts-reference.md#advisor-silence-plugin-policy-and-qa).

## Project-specific verifier requirements

Add a project `WATCHDOG.yml` entry named `verifier` when a repository needs a requirement beyond the default advisor:

```yaml
advisors:
  - name: verifier
    tools: [bash]
    instructions: |
      @/home/<user>/.omp/agent/verifier/WATCHDOG.md

      - Check id project:database-migrations. When a database migration changes, run `npm run db:verify`; the quality standard is current migration status, evidenced by exit 0 and the command's status output.
```

Each requirement names its trigger, check id, quality standard, executable narrow check, and PASS evidence. The verifier must execute the applicable check; merely proposing a future check does not establish verification. It ignores placeholders and generic guidance. Commands without structured output are classified from the observed exit/output and the explicit quality standard using the same result shape.

## Commands

```text
/verifier
/verifier status
/verifier checks
/verifier verify
/verifier verify <check-id...>
/verifier uninstall
```

`/verifier checks` lists valid checks declared by installed plugin manifests. `/verifier verify` runs all discovered checks; named IDs run only the requested checks. Deterministic results are `PASS`, `FAIL`, or `BLOCKED`. A supported semantic result includes `reviewRequest` and has status `PENDING` whether the assessment is ready or awaits recoverable context; it is not a final verdict. The verifier advisor must complete the semantic assessment before delivering any final `FAIL`/`BLOCKED`.

After a completed changed run in a Git worktree, the verifier model passes only that run's project-relative changed paths to the packaged `automatic` coordinator. It does not select unrelated uncommitted paths from earlier runs. Matching `pathTriggers` and applicable project `requirements` select installed checks; JSON records the changed paths and matching triggers. The advisor completes every supported PENDING semantic request before delivering final results; unread review pages are advisor work, not a blocker or an unavailable prerequisite. Final text results omit selection metadata and preserve status, check ID, supplied standard/source and quality standard, evidence, and next check. `PASS`, `SUPPRESSED`, and no results stay silent; only final `FAIL`/`BLOCKED` results reach OMP's native blocker channel. Checks without triggers or applicable requirements remain manual. `automatic --worktree` is only for an explicitly requested full working-tree check.

Automatic selection reconciles later reversals before invocation. When a candidate was restored or its delivery completed, a targeted comparison against the evidenced run/delivery base establishes whether it still belongs. A `HEAD`-only comparison must not discard committed changes or authenticated deletions. Compaction replay and historical diagnostics are not fresh edit triggers. Obsolete-scope failures remain historical evidence rather than current blockers; a different scope's PASS does not rewrite them. These are advisor selection/reporting instructions, not a runtime freshness gate; direct CLI callers remain responsible for the explicit paths they supply.

Changed paths retain their edit-owned checkout: the advisor resolves transcript tool paths and working directories before invoking the coordinator, groups changes by Git root, and runs each complete group from its owning checkout. The session's startup directory or a same-named file in another worktree is not source identity. Recovery stays in the validated request root; an incorrect initial root requires a fresh complete-group request, not context from a neighboring checkout. Unresolved checkout ownership is BLOCKED rather than guessed.

With no compatible manifests or applicable project requirements, `checks` reports `none installed`, `verify` reports `BLOCKED`, and the automatic coordinator returns an empty array. An applicable requirement whose provider is absent returns BLOCKED instead. Advisor setup and cleanup remain independent of the check surface.

The `bash`-only advisor can discover and run named checks using the packaged CLI:

```text
omp-verifier checks
omp-verifier verify <check-id...>
omp-verifier automatic <changed-path...>
omp-verifier review <request-file> [--context <path[#Lstart-Lend]>...] [--caller-context <path[#Lstart-Lend]>...] [--reporter json|text] [--page <index>]
omp-verifier evaluate <request-file> --assessment <JSON|->
```

JSON remains the default reporter; `--reporter json` selects it explicitly. `checks` writes `{ "checks": [...], "blockedResults": [...] }`; discovery never executes checks. `verify`, `automatic`, and `evaluate` write result arrays and support `--reporter text` and `--failures-only`. Failure-only output retains `PENDING` review requests and `SUPERSEDED` lifecycle results needed for recovery, as well as final `FAIL`/`BLOCKED`; successful results are omitted. Any final `FAIL`/`BLOCKED` exits `1`; otherwise successful execution exits `0`, including semantic preparation, retrieval, and missing-page recovery. Invocation errors exit `2`. Exit `0` alone is not PASS: a PENDING result still requires assessment, and a skipped or suppressed check is not approval. `evaluate --assessment -` reads literal JSON from stdin. Named verification shares its runner with `/verifier verify`; the generated prompt uses the installed CLI's absolute path rather than requiring it on `PATH`.

For model/human inspection, `review <request-file> --reporter text` starts at page `0`. Each page is at most 24,000 UTF-8 bytes and contains a JSON fragment plus the exact request path/ID, byte range, page count, and next index. Long display lines wrap at 600 UTF-8 bytes with backslash-newline continuations; remove those without adding a newline. Byte offsets and citation keys refer to the original unwrapped JSON/source, not display rows. The first bounded text presentation enrolls that request; each valid page served records its request identity, evidence-view fingerprint, index, and count. Read and inspect every page before evaluating the entire original scope once. These receipts account for delivery, not comprehension: page calls or metadata alone do not prove that the advisor inspected the evidence or establish its scope. For an enrolled request, `evaluate` with missing pages remains `PENDING`, ignores the draft assessment, and reports `reviewProgress.nextPage` (the first missing index) and `missingPages`; retrieve and inspect the missing page before continuing. CLI text output immediately presents that page and records its delivery too. Requests used only through JSON/API remain unchanged unless already enrolled in text paging, and switching an enrolled request to JSON cannot bypass its outstanding pages. Text page delivery does not renew or consume the request. Context options belong on page `0`; context recovery renews the request identity and resets page receipts, so start again at page `0` on the renewed request without repeating context options. Use each page footer's literal `Next command` (including the evaluate command on the final page), after removing display continuations, rather than reconstructing it. Multiple reported results retain separate request handles rather than concatenating large pages. A recovery response's page `0` also counts as delivered: inspect it and continue from its reported next index. Preserve the returned request path and ID exactly; if a copy error produces an unavailable/superseded response, compare it with the last returned identity and retry the exact returned command before preparing a new request.

The advisor runs, for example:

```text
omp-verifier automatic api/tests/downloads.test.ts --reporter text --failures-only
```

Its blocker note contains the reporter output, without JSON or a code fence:

```text
FAIL marlens-rules:test-alignment
  1 test-alignment violation found.
  Evidence: api/tests/downloads.test.ts:169: missing ordered Arrange, Act, Assert comments.
  Next check: Add ordered comments to the test.
```

Evidence and next-check text come from the check, not a model rewrite. Multiline fields retain line breaks and indentation. Selection metadata remains available through JSON.

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

Without `mode`, an entry is a package-relative `.mjs` module that writes one JSON result with `PASS`, `FAIL`, or `BLOCKED`. Valid `FAIL` and `BLOCKED` results may exit nonzero when stderr is empty; the verifier preserves their summary, evidence, and next check. A `PASS` paired with a nonzero exit is `BLOCKED`, not successful verification. Automatic executable entries receive `OMP_VERIFIER_CHANGED_PATHS` as a JSON array of their matching project-relative paths; manual `/verifier verify` removes it. The package must expose an `omp.extensions` or `pi.extensions` entry; executable checks run without a shell in the active project directory. `pathTriggers` is an optional non-empty array of project-relative glob patterns. Invalid manifests, traversal, duplicate IDs, timeouts, malformed output, missing entries, and other non-zero exits fail closed as `BLOCKED`; model-supplied executable paths are never accepted.

`/verifier verify` does not scan remote repositories or execute arbitrary `verify-*` files. Installed plugin code remains trusted; the manifest is a discovery convention, not a sandbox.

### Supplied standards verification

OMP Verifier 0.10.0 also accepts an explicit semantic contract instead of an executable entry:

```json
{
  "id": "marlens-rules:module-boundary-alignment",
  "label": "Module Boundary Alignment",
  "description": "Evaluates changed modules against the accepted module-boundary standard.",
  "mode": "agentic",
  "contract": "./verifications/module-boundary-alignment.json",
  "pathTriggers": ["**/*.js", "**/*.ts"]
}
```

The provider supplies the versioned standard/source, quality standard, required context, and rubric. The existing verifier model judges that declared contract against captured changed code, caller/sibling context, and project guidance; it does not substitute file-size metrics or generic review. See the [semantic contract and assessment protocol](docs/references/verifier-concepts-reference.md#agentic-standards-contract) for the schema, evidence limits, and planned versioned field migration. Version 1 still requires the `gold` wire field; visible terminology does not rename installed contracts.

Preparation returns a private current review request. `review` exposes it; `--context` captures additional project files and renews its request ID. `evaluate` validates the assessment's current ID, source citations, and unchanged provider/project context before returning a final result. If recoverable evidence is missing, the result remains `PENDING` with `reviewRequest`; unsupported contracts, tampering, replay, stale evidence, or genuinely unavailable material without a recoverable request can produce final `BLOCKED`. Correction requires a fresh evaluation, or a deliberate bounded exception with its reason; an old PASS cannot clear a newer failure.

A late `review` or `evaluate` of a superseded request returns the validated pending replacement request without applying the old assessment or context selectors. Read its complete scope and all pages from page `0` before assessing its current ID. If the replacement was already assessed, the obsolete operation returns `SUPERSEDED`, not a quality verdict or PASS; it must not become native blocker advice. Missing context in a valid current request remains PENDING while recovery is attempted. Missing state, tampering, and stale current evidence remain final `BLOCKED` without `reviewRequest`; prepare a fresh request rather than assessing stale evidence.

Context recovery prioritizes changed code, explicit files/ranges, and owning/ancestor guidance before optional broad evidence. Oversized relevant guides expose a bounded initial excerpt with omitted ranges; recover a material section with, for example, `review <request-file> --reporter text --context 'api/tests/README.md#L130-L150'`. Repeat `--context` for separate chunks and use the renewed request ID. Excerpts preserve original line numbers and hash the full bounded source so edits outside the excerpt invalidate the request. Partial capture and incomplete inventories remain explicit, not proof of complete guidance or caller coverage; recoverable gaps remain PENDING, while material evidence that cannot be recovered yields final BLOCKED without `reviewRequest`.

Changed paths and explicit material dependencies determine required owning guidance, not every heuristic caller match. Add a material caller/sibling with `--context` to include its boundary. A complete sibling inventory establishes directory membership, not a requirement to capture every sibling's contents; optional sibling rejections alone do not block assessment. Select the actual schema/backfill dependencies and runner source needed by the rubric, including relevant files beyond the initial admission window. Before reporting a budget blocker, inspect the renewed request's `missingContext`, `context.guidanceRequirements`, and `context.evidenceBudget` for the specific unavailable material evidence and exact competing records. Recoverable required evidence keeps the result PENDING; capacity limits that prevent recovery yield final BLOCKED. An empty `missingContext` is readiness for judgment, not PASS.

For a runner-discovered test with no source importers, supply real runtime caller evidence rather than inventing an import: `review <request-file> --reporter text --caller-context web/package.json --caller-context web/vitest.config.ts`. This labels captured source for the assessor; it does not infer discovery from test names or approve a no-caller claim. Explain applicability under the supplied rubric and cite both the changed test and captured runner source. Recoverable missing material callers keep the review PENDING; callers that cannot be obtained within supported limits yield final BLOCKED. `context.callerRetrieval` reports inventory/read limits, omitted path examples, and unreadable records without claiming global coverage.

Required changed code above the 16 KB record limit can be recovered with the same ranged selectors. Cover every original line within the existing source, selector, and total-evidence budgets; `changedCodeCoverage` reports covered and omitted ranges. An incomplete excerpt keeps the semantic result PENDING while supported recovery remains possible; if complete coverage cannot fit within supported bounds, the final result is BLOCKED. Sources outside the supported bounds are not split or judged by size.

Ordinary requests admit up to 256,000 bytes across 40 evidence files. When the distinct union of changed paths, explicitly selected material context, and owning guidance exceeds 40 paths, capture automatically uses a bounded large-scope budget of 1,024,000 bytes across 256 evidence files. Optional caller/sibling discovery alone never expands the budget. `context.evidenceBudget` reports the selected ceilings and `requiredFiles`; retained deleted source counts against the same limits. The complete scope is assessed together using built-in paging, not manual scope splitting. Per-source, record, selector, inventory, freshness, and citation limits remain enforced. Recoverable required capacity stays PENDING during recovery; limits that prevent complete required evidence yield final BLOCKED without `reviewRequest`.

Committed deletions can recover their prior source directly from local Git history, even before the first semantic capture. Keep the deleted path in the changed scope; if the source is not otherwise available and Git history cannot recover it within bounded capture, the final result is BLOCKED without `reviewRequest`.

For a disposable source file that will be removed before final-yield review, use the [pre-cleanup source handoff](docs/references/verifier-concepts-reference.md#transient-source-handoff) while its final contents still exist. This uses the existing coordinator without an earlier model review; it cannot recover never-captured source retroactively.

Native blocker delivery initiates correction but is not a hard completion gate. This plugin does not register a `session_stop` veto or atomically wait for the current named-advisor result before settlement. See the [completion boundary](docs/references/verifier-concepts-reference.md#completion-boundary) for the native OMP dependency and supported stop-hook distinction.


### Scoped requirements and automatic-check suppression

Use `.omp-verifier.json` at the Git root or beneath the affected subtree. Its `path` is relative to that file and must not match the entire project:

```json
{
  "requirements": [{
    "id": "marlens-rules:module-boundary-alignment",
    "path": "src/**"
  }],
  "suppressions": [{
    "id": "publisher:check-id",
    "path": "legacy-tests/**",
    "reason": "The vendor fixture is intentionally outside this check's contract.",
    "expires": "2026-12-31"
  }]
}
```

A requirement names a check ID and bounded path. It selects that check for matching current changes even without a manifest trigger; a missing required provider is observable `BLOCKED`. A valid bounded suppression may cover an installed or explicitly required ID, including an absent required provider; its reason remains visible as `SUPPRESSED`, never PASS. Suppressions require a non-empty reason; `expires` is optional, but invalid/expired entries and undeclared unknown IDs are `BLOCKED`. Paths are relative to the configuration file. A missing `.omp-verifier.json` has no effect.

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

For advisor-correction releases, use a disposable declared failing check or supplied semantic contract:

1. Record installed OMP, Verifier, and provider versions. Check `/advisor status` for an enabled, resolved `verifier` model; `[no model]` or a current runtime error blocks that model's correction claim. Freeze synthetic inputs and provider artifacts before the live cycle.
2. Wait for actual RPC readiness or the terminal's initialized editor, not just a version banner or elapsed delay. Answer terminal queries, including cursor-position requests, when using a raw PTY. Confirm successful prompt admission; a primary still processing cannot accept an ordinary new prompt.
3. Save named-verifier transcript and primary/event baselines for this scenario. Trigger the intended changed paths using the packed or remotely installed coordinator and confirm those paths were actually selected. For committed code, use the provider's supported comparison-base input; a no-applicable-work PASS is not inspected-code evidence.
4. Correlate the current check, scope, semantic request identity when applicable, final coordinator result, and completed named-advisor review. A settled primary RPC prompt, an earlier private final, or an unrelated result cannot prove this review. Observe `<advisory advisor="verifier" severity="blocker">` and compare its note with current `--reporter text --failures-only` output; preserve status, check ID, summary, evidence, and next check without extra commentary.
5. Observe actual primary remediation, then request a fresh independently triggered assessment of the corrected scope, including deletions. Require a current evaluated-code PASS, not the old result or a planned check. Before submitting another ordinary RPC prompt, also confirm the primary's previous prompt has settled.
6. For `PASS`, `SUPPRESSED`, and no results, require the current named review to complete without delivered verifier advice. Preserve earlier completed scenarios when a later continuation fails; retain each error in its actual scenario window. A current error without a completed current result remains FAIL/BLOCKED.
7. Record any explicitly authorized task-local model override separately from normal-selector coverage; leave default models, provider configuration, credentials, and fallback chains unchanged. Setup/version assertions, startup-only timeouts, and incomplete terminal protocol support are harness failures, not coding-standard verdicts or evidence of a general provider outage.
8. If remediation remains incomplete, exercise a fresh applicable trigger after `advisor.immuneTurns` and observe repeated failure delivery; waiting alone does not prove a new assessment.

See [Native QA Evidence Attribution](docs/references/verifier-concepts-reference.md#native-qa-evidence-attribution) for completion boundaries and evidence ownership. Keep diagnostics bounded to the plugin outcome; this recipe does not introduce advisor scheduling, model selection, or a permanent QA runner.

Do not claim publish, install, or advisor correction without observed evidence.
