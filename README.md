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

For routine development, use current check results to guide repairs and request a fresh scoped recheck after fixing a reported problem. Silence alone is not proof that a check ran. Verifier is an advisory development aid, not a fail-closed completion gate: [automatic repair reassessment](https://github.com/klondikemarlen/omp-verifier/issues/150), [literal evidence relay](https://github.com/klondikemarlen/omp-verifier/issues/171), and [context exhaustion during long reviews](https://github.com/klondikemarlen/omp-verifier/issues/206) remain known native-advisor limitations. Missing prerequisites remain BLOCKED, not approval.

### Waive a Verifier gate

To continue without a Verifier closeout receipt, enter `/verifier waive verifier:resource-closeout`, confirm the waiver, then submit the prompt requesting cleanup. By default the waiver applies to that prompt only. For repeated work in the same live session, explicitly append `--session`.

Use an installed check ID to waive only that check, or `verification` to waive the whole verification run. A waiver records **waived by user**. It neither erases earlier findings nor satisfies CI, branch protections, or filesystem permissions.

## Install

```bash
omp plugin install github:klondikemarlen/omp-verifier
```

Runtime generation handover requires Linux `flock` and storage for the installed verification providers and their dependency closure. See [runtime generations](docs/references/verifier-concepts-reference.md#runtime-generations) for activation, retention, and migration boundaries.

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

The plugin copies its active generation's guidance to `<agent-dir>/verifier/WATCHDOG.md` on setup. It substitutes the shell-quoted persistent launcher at `<agent-dir>/verifier/omp-verifier.mjs`, outside the replaceable plugin package. The roster imports that generated file. Extension registration awaits reconciliation before the first advisor import; session start also reconciles the active profile. Put custom requirements in project `WATCHDOG.yml`, not this generated file.

The empty `default` entry uses OMP's stock advisor behavior. The verifier prompt specializes its model as a check selector/executor, not a reviewer. It stays silent for `PASS`, `SUPPRESSED`, or no results. For `FAIL` and `BLOCKED`, it sends a result-first [findings note](#read-the-results-behind-an-advisor-note) through the existing native `advise` channel with severity `blocker`. OMP labels that channel “Advisor.” Result-only output and silence are prompt contracts, not runtime-enforced admission.

## Read the results behind an advisor note

A Verifier findings note groups the completed check results by PR or MR and affected location. The native Advisor's note/blocker count is separate from the Verifier's count of checks and attributed findings. Each judgment stays linked to its check; a provider that emits only prose is shown as a check-level result, not as a guessed measurement or source location.

The note is a preview. Before quoting evidence or repairing a finding, open the report with the installed coordinator and the note's full 64-character lowercase hexadecimal report ID. Use the stored check result, not a quotation copied into the note. For delivery findings, match the checkout and current PR/MR target, base and head. If the report is unavailable or does not match, obtain current check evidence instead. Reading a report does not rerun verification.

```sh
node "<agent-dir>/verifier/omp-verifier.mjs" report show <report-id> --reporter text
node "<agent-dir>/verifier/omp-verifier.mjs" report show <report-id> --reporter json
node "<agent-dir>/verifier/omp-verifier.mjs" report show <report-id> --evidence 1
```

`--evidence` writes one check's literal retained evidence, with no added whitespace. Its one-based check number is shown in the text detail view. Retrieval reads the same OMP profile's owner-only report, does not run any check or require the original checkout, and does not certify current code. If the report is missing or has changed, retrieval fails rather than falling back to a recent check. The existing Ctrl+O path for older lint-only notes remains available where OMP supports it; a compact findings note links to the exact report regardless of that setting.

## Preview advisor cards

Run `/verifier demo` in an interactive OMP terminal to preview sample `FAIL` and `BLOCKED` findings using OMP's actual advisor-card renderer, including native Tern cards and ordinary terminal rendering. A bordered preview temporarily replaces the input editor instead of floating over the conversation. It shows one sample at a time: press **Tab** to switch samples and **Escape** or **Enter** to close and restore the editor. Automatic `PASS` and inapplicable checks are normally silent; the demo does not invent a success card.

The preview is display-only: it runs no checks, sends no advisor messages, records no verdicts, and changes no verification state. Every card is labeled as a sample, not a finding about your project. Normal `/verifier verify` remains a plain manual-result notification. Internal request coordination stays hidden, and automatic advisor silence is not proof of success.

The preview requires an OMP host exposing the public advisor-card renderer (verified with OMP 18.20.0). If that capability is unavailable, the command reports the limitation instead of substituting a look-alike.

## Request-sized work

Start a request with `Verifier work level: quick tweak`, `Verifier work level: normal`, or `Verifier work level: rearchitecture` on its first line. The choice applies only to that request; the next request defaults to normal. Request-level coordination stays out of the chat while remaining available to the native advisor. Quoted declarations elsewhere in a prompt do not select a mode.

An eligible mechanical quick tweak omits optional automatic checks, not mandatory project requirements or explicitly requested verification. Public/serialized-field changes, authorization changes, and other behavioral changes require normal verification even with a quick prefix. Initial delivery and release gates remain effective. Normal follow-ups can reuse exact, freshness-validated semantic results; changed evidence requires fresh assessment. Skipping is not PASS, and current failures are not cleared. See [request intent and proof reuse](docs/references/verifier-concepts-reference.md#request-intent-and-proof-reuse) for the contract and host limitations.

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
/verifier status --details
/verifier status --usage
/verifier checks
/verifier verify
/verifier verify <check-id...>
/verifier timings
/verifier demo
/verifier generation
/verifier generation prepare
/verifier generation activate <generation-id>
/verifier generation status
/verifier generation collect
/verifier closeout prepare <declaration.json>
/verifier closeout verify <receipt.json>
/verifier closeout review <handoff-id>
/verifier uninstall
/verifier waive <verification|namespace:name> [--session]
```

`/verifier` and `/verifier status` show a setup snapshot: the version loaded by this OMP process, whether the verifier is configured globally, whether advisor guidance is installed, and whether the project has its own roster. No project roster is required. If global setup is missing, start a fresh OMP session to restore managed files. Use `/advisor status` to check live activity; a setup snapshot does not say whether the verifier is running.

Use `/verifier status --details` for advisor names, full generation identifiers, and configuration paths. The setup report stays in the conversation on supported OMP hosts without starting a model turn. Its text carries the same facts if the custom frame is unavailable. The loaded plugin and selected coordinator generation can have different versions; use the details view to compare them.

Use `/verifier status --usage` to see how often each menu option was invoked across projects in your current OMP profile. The report separates bare `/verifier` from explicit `status` and shows when observation began. See [command usage](docs/references/verifier-concepts-reference.md#command-usage) for what counts and what stays private.

`/verifier checks` lists valid checks declared by installed plugin manifests. `/verifier verify` runs all discovered checks; named IDs run only the requested checks. Deterministic results are `PASS`, `FAIL`, or `BLOCKED`. A supported semantic result includes `reviewRequest` and has status `PENDING` whether the assessment is ready or awaits recoverable context; it is not a final verdict. The verifier advisor must complete the semantic assessment before delivering any final `FAIL`/`BLOCKED`.

Verifier includes `verifier:project-lint`, a bounded catalog for JavaScript/TypeScript (ESLint or Oxlint), Ruby (RuboCop), Go (golangci-lint), Python (Ruff or explicitly selected Pyflakes), and Shell (ShellCheck). It discovers existing project tooling before running it; missing or unsupported tooling is `BLOCKED`, actual lint violations are `FAIL`, and successful applicable commands are `PASS`. It never installs tools or creates lint configuration. See [project lint discovery and wrappers](docs/references/verifier-concepts-reference.md#project-lint-catalog) for supported signals, scope, and wrapper declarations.

For lint-only notes, enable OMP’s `extensionRenderers.transcriptPresenters` setting (off by default in OMP 19.2.1) to use Ctrl+O. It switches between the compact lint verdict and the original card with its retained evidence, without rerunning lint or recovering discarded output. Combined findings notes do not depend on transcript presenters.

For current PR or MR changes, the advisor passes `--base <actual-base>` to `automatic`. This includes earlier commits in the proposed change; stacked PRs use their immediate parent. Matching `pathTriggers` and applicable project `requirements` select installed checks. Only final `FAIL` and `BLOCKED` results reach the primary. Direct CLI callers can still select explicit paths without a base or request a full working-tree check with `automatic --worktree`.

Required PR verification belongs **before merge**. Immediately before starting or resuming automatic review, the advisor checks the hosting service for an open PR or MR with the expected base and head. If it has merged or closed, the advisor skips the old request; that is not a PASS. You can explicitly request a retrospective check on the pinned revisions. Post-merge CI is independent.

The proposed diff is the review target, not every file in the checkout. Status, exit, and post-merge housekeeping do not start a source review.

Automatic selection reconciles later reversals before invocation. When a candidate was restored or its delivery completed, a targeted comparison against the evidenced run/delivery base establishes whether it still belongs. A `HEAD`-only comparison must not discard committed changes or authenticated deletions. Compaction replay and historical diagnostics are not fresh edit triggers. Obsolete-scope failures remain historical evidence rather than current blockers; a different scope's PASS does not rewrite them. These are advisor selection/reporting instructions, not a runtime freshness gate; direct CLI callers remain responsible for the explicit paths they supply.

Changed paths retain their edit-owned checkout: the advisor resolves transcript tool paths and working directories before invoking the coordinator, groups changes by Git root, and runs each complete group from its owning checkout. The session's startup directory or a same-named file in another worktree is not source identity. Recovery stays in the validated request root; an incorrect initial root requires a fresh complete-group request, not context from a neighboring checkout. Unresolved checkout ownership is BLOCKED rather than guessed.

Before removing a clean committed delivery worktree whose final review is still outstanding, prepare a [delivery handoff](docs/references/verifier-concepts-reference.md#delivery-handoff): `omp-verifier handoff prepare --base <actual-delivery-base>`. Preserve its returned path in the transcript. The verifier can recover that exact source into a private detached checkout and run fresh checks after normal cleanup. Recovery is not approval; missing execution prerequisites still produce BLOCKED. Uncommitted work must remain in its original checkout.

Routine cleanup does not require a Verifier receipt. Use the project's normal safety checks for ownership, unmerged work, unique data, and active consumers. If resource verification is explicitly requested, use the separate [resource closeout check](docs/references/verifier-concepts-reference.md#resource-closeout). Skipping that check is not a PASS or permission to delete.

The installed Verifier package supplies its own lint manifest; additional plugins may supply other checks. In an isolated package directory with no compatible manifests, `/verifier checks` reports that no usable checks were found and `/verifier verify` reports `BLOCKED`. Installed but inapplicable checks return no selected results; that is not a verdict. An applicable requirement whose provider is absent returns `BLOCKED` instead. Advisor setup and cleanup remain independent of the check surface.

The `bash`-only advisor can discover and run named checks using the packaged CLI:

```text
omp-verifier checks
omp-verifier verify <check-id...> [--max-source-bytes <bytes>]
omp-verifier automatic [--progress] [--base <actual-PR-base>] [<changed-path>...] [--whole-file <cleanup-path>...] [--max-source-bytes <bytes>]
omp-verifier automatic --request <current-handle> --full --base <actual-PR-base> [--lint-budget-ms <milliseconds>]
omp-verifier lint --budget-ms <milliseconds> <changed-path>... [--reporter json|text] [--failures-only]
omp-verifier review <request-file> [--continue|--batch <index>] [--max-context-paths <30-256>] [--context <path[#Lstart-Lend]>...] [--caller-context <path[#Lstart-Lend]>...] [--external-context <pinned-source-URL[#Lstart-Lend]>...] [--remove-context <retained-selector>...] [--reporter json|text] [--page <index>]
omp-verifier evaluate <request-file> --assessment <JSON|->
omp-verifier diagnostics <request-file> [--reporter json|text]
omp-verifier report show <report-id> [--reporter json|text] [--evidence <check-number>]
omp-verifier closeout prepare <declaration.json>
omp-verifier closeout verify <receipt.json> [--reporter json|text] [--failures-only]
omp-verifier closeout review <handoff-id> [--reporter json|text] [--failures-only]
omp-verifier automatic --closeout <receipt.json> [<changed-path>...]
```

Use `omp-verifier --help` for the command list and `omp-verifier <command> --help` for its options. Lifecycle groups also provide action help, such as `omp-verifier handoff prepare --help`. Help exits `0` without running checks. Options belong to their command: irrelevant flags, extra arguments, and invalid combinations are rejected before execution.

JSON remains the default reporter; `--reporter json` selects it explicitly. `checks` writes `{ "checks": [...], "blockedResults": [...] }`; discovery never executes checks. `verify`, `automatic`, and `evaluate` write result arrays and support `--reporter text` and `--failures-only`. Failure-only output retains `PENDING` review requests and `SUPERSEDED` lifecycle results needed for recovery, as well as final `FAIL`/`BLOCKED`; successful results are omitted. Any final `FAIL`/`BLOCKED` exits `1`; otherwise successful execution exits `0`, including semantic preparation, retrieval, and missing-page recovery. Invocation errors exit `2`. Exit `0` alone is not PASS: a PENDING result still requires assessment, and a skipped or suppressed check is not approval. `evaluate --assessment -` reads literal JSON from stdin. Named verification shares its runner with `/verifier verify`; the generated prompt uses the installed CLI's absolute path rather than requiring it on `PATH`.

Use `review <request-file> --reporter text` to inspect a semantic request. Follow its page-footer commands until the complete scope has been reviewed and assessed; retrieval success alone is not PASS. The [semantic protocol reference](docs/references/verifier-concepts-reference.md#agentic-standards-contract) owns page delivery, request identity, recovery, and citation details.

To see why a semantic review is still pending, use `diagnostics <request-file>`. It reports source-free progress and measured coordinator time without reading pages on the reviewer's behalf or approving the source. The [diagnostics contract](docs/references/verifier-concepts-reference.md#review-diagnostics) explains timing limits and cached terminal status.

You can type and queue a follow-up while automatic verification runs. Use `automatic --progress` to see check transitions on the ordinary Bash card without a PTY. In the interactive TUI, the verifier advisor’s Bash card is private; an editor widget shows its current check and budget when known. A quiet interval does not establish a hang. Afterward, use `/verifier timings` in the same directory for the [run history](docs/references/verifier-concepts-reference.md#run-timings).

After a cancellation, rerun the same `automatic`, `verify`, `lint`, or `handoff check` command in the same checkout. Verifier restores completed work; the check or lint group that was still running starts again. Use `--fresh` if an external input changed. See [interrupted verification](docs/references/verifier-concepts-reference.md#interrupted-verification) for the reuse boundaries.

Private dependencies already available in a local Git checkout can use `--external-context 'git+file:///absolute/repository?revision=<full-commit>&path=<file>#Lstart-Lend'`. Select only material evidence within the task's existing permissions; no new approval prompt or grant file is required. The [external evidence contract](docs/references/verifier-concepts-reference.md#agentic-standards-contract) explains provenance, limits, recovery, and private-output handling.

When required evidence exhausts the aggregate capture budget, opt in once with `review <request-file> --continue --reporter text`. This renews the complete obligation into bounded batches. Follow every page and submit cited checkpoints, then one final cross-batch assessment. Use `review <current-request-file> --batch <index> --reporter text [--page <index>]` to reinspect source. Do not repeat `--continue`: it discards saved progress.

If the reviewer is nearing its context limit after an accepted checkpoint, use `resume-checkpoint <current-request-file>` in the owning checkout to hand the remaining review to a fresh native verifier. For an automatic delivery review, also pass `--pull-request <PR-or-MR-URL> --target-branch <branch>`. See [checkpoint recovery, limits and freshness](docs/references/verifier-concepts-reference.md#bounded-semantic-continuation).

For an explicitly authorized one-off larger changed-source capture, start `automatic` or `verify` with `--max-source-bytes`; see the [capture-limit contract](docs/references/verifier-concepts-reference.md#agentic-standards-contract) for supported bounds and request-local behavior.

If PR lint needs more time, retry the same full verification with its actual base and `--lint-budget-ms`. Do not substitute standalone lint: without the PR boundary it can run a whole-project command. See [bounded lint recovery](docs/references/verifier-concepts-reference.md#recovering-slow-whole-project-lint).

For a PR targeting `origin/main`, the advisor runs, for example:

```text
omp-verifier automatic --base origin/main api/tests/downloads.test.ts --progress --reporter text --failures-only
```

Its blocker note contains the reporter output, without JSON or a code fence:

```text
FAIL marlens-rules:test-alignment
  1 test-alignment violation found.
  Evidence: api/tests/downloads.test.ts:169: missing ordered Arrange, Act, Assert comments.
  Next check: Add ordered comments to the test.
```

Evidence and next-check text come from the check, not a model rewrite. Multiline fields retain line breaks and indentation. Selection metadata remains available through JSON.

**PR verification targets changed files.** `--full` selects all applicable checks, not all files. An unchanged caller, sibling or test is not an automatic target. Verifier may read the rules and tool configuration governing a changed file. If the verdict requires other source, identify the missing file rather than silently adding it. A user-requested file, directory or repository cleanup is a separate, explicitly scoped audit. Independent CI and a project's release commands are not PR-scoped Verifier runs.

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
      "executionScope": "changed-files",
      "pathTriggers": ["tests/**", "**/*.test.js"],
      "timeoutMs": 30000
    }]
  }
}
```

Without `mode`, an entry is a package-relative `.mjs` module that writes one JSON result with `PASS`, `FAIL`, or `BLOCKED`. Valid `FAIL` and `BLOCKED` results may exit nonzero when stderr is empty; the verifier preserves their summary, evidence, and next check. A `PASS` paired with a nonzero exit is `BLOCKED`, not successful verification. Automatic executable entries receive `OMP_VERIFIER_CHANGED_PATHS` as a JSON array of their matching project-relative paths; manual `/verifier verify` removes it. The package must expose an `omp.extensions` or `pi.extensions` entry; executable checks run without a shell in the active project directory. `pathTriggers` is an optional non-empty array of project-relative glob patterns. Invalid manifests, traversal, duplicate IDs, timeouts, malformed output, missing entries, and other non-zero exits fail closed as `BLOCKED`; model-supplied executable paths are never accepted.

For automatic PR execution, a deterministic provider must declare `"executionScope": "changed-files"`. This promises that every verification target, including targets passed to child processes, comes from `OMP_VERIFIER_CHANGED_PATHS`. Reading a tool configuration is not checking the configuration as source. `pathTriggers` alone only selects a provider; it says nothing about the files its command will check. Without the declaration, an optional executable is suppressed and an applicable required executable is blocked. Neither is a pass. This is a contract for trusted providers, not an operating-system sandbox.

A deterministic entry may instead return `N/A` with a non-empty summary and exit `0` when it has no applicable work. The coordinator removes that non-verdict from manual and automatic result arrays; it is not `PASS`. A nonzero exit cannot hide behind `N/A`. Semantic assessments still require `PASS`, `FAIL`, or `BLOCKED`.

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

The advisor assesses the complete current scope against the provider's supplied rubric. Recoverable evidence gaps remain pending work; source size or an incomplete excerpt is not a quality verdict. A fresh assessment is required after correction.

If every semantic check is reading the same project manual, you can mark it as reference material in the repository-root `.omp-verifier.json`:

```json
{ "review": { "referenceGuides": ["README.md", "WATCHDOG.md"] } }
```

List exact paths to manuals reviewers should consult as needed, not instructions that govern every change. Reviewers can retrieve material sections with `review --context`; changes to the manual itself remain in scope. Projects without this setting need no migration.

See the [semantic protocol reference](docs/references/verifier-concepts-reference.md#agentic-standards-contract) for complete-source recovery, owning guidance, evidence limits, supersession, and source/citation validation. Native blocker delivery supports correction but is not a hard [completion gate](docs/references/verifier-concepts-reference.md#completion-boundary).


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

`/verifier uninstall` removes the marked verifier block and unchanged generated guidance. It does not uninstall the package or change project configuration; `default` and independent advisors such as `learner` stay in place.

## Development and release

Use Node `^20.19.0 || ^22.13.0 || >=24` for development (CI uses Node 22). Run `npm ci --ignore-scripts` to install the locked development tools, then `npm run lint` for non-fixing ESLint checks over the CLI, runtime, tests, and lint configuration. Recommended JavaScript rules apply with Node globals and zero allowed warnings. `npm run release:check` runs lint, syntax checks, and the test suite; it is also the CI gate. Lint tooling is development-only and is not required to run the installed plugin.

For edits to `omp-plugin/semantic-*.js`, this checkout's [scoped requirement](.omp-verifier.json) selects the installed `marlens-rules:module-boundary-alignment` check even when optional checks are skipped. Review the touched implementation against the [module-boundary standard](https://github.com/klondikemarlen/marlens-skills-rules-and-tools/blob/main/docs/references/module-boundary-reference.md#ownership-before-extraction): trace who owns discovery, admission and assessment, including the failure path. Passing lint or staying under a file-size ceiling does not answer that question. A missing standards provider is `BLOCKED`, not a pass.

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
4. Correlate the current checks, scope, any semantic request identity, and completed named-advisor review with the primary's `<advisory advisor="verifier" severity="blocker">`. For combined findings, observe the actual primary terminal with expansion off, then copy that exact note's report ID and compare `report show` JSON and literal `--evidence` output with both original coordinator results. Compare the delivered note with the stored `note` field separately; retrieval does not establish exact native relay. Exercise conflicting check evidence, remediation followed by a fresh PASS, and silence when no result is reportable.
5. Observe actual primary remediation, then request a fresh independently triggered assessment of the corrected scope, including deletions. Require a current evaluated-code PASS, not the old result or a planned check. Before submitting another ordinary RPC prompt, also confirm the primary's previous prompt has settled.
6. For `PASS`, `SUPPRESSED`, and no results, require the current named review to complete without delivered verifier advice. Preserve earlier completed scenarios when a later continuation fails; retain each error in its actual scenario window. A current error without a completed current result remains FAIL/BLOCKED.
7. Record any explicitly authorized task-local model override separately from normal-selector coverage; leave default models, provider configuration, credentials, and fallback chains unchanged. Setup/version assertions, startup-only timeouts, and incomplete terminal protocol support are harness failures, not coding-standard verdicts or evidence of a general provider outage.
8. If remediation remains incomplete, exercise a fresh applicable trigger after `advisor.immuneTurns` and observe repeated failure delivery; waiting alone does not prove a new assessment.

See [Native QA Evidence Attribution](docs/references/verifier-concepts-reference.md#native-qa-evidence-attribution) for completion boundaries and evidence ownership. Keep diagnostics bounded to the plugin outcome; this recipe does not introduce advisor scheduling, model selection, or a permanent QA runner.

Do not claim publish, install, or advisor correction without observed evidence.
