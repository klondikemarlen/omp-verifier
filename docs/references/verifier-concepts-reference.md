# OMP Verifier Concepts Reference

## Product Shape

OMP Verifier uses a second advisor as the model-driven selector/executor of declared checks and evaluator of explicit supplied standards contracts. It is not another general reviewer or a replacement for OMP's default advisor.

```mermaid
sequenceDiagram
  participant Main as Primary agent
  participant Verifier as Verifier advisor
  participant CLI as Automatic coordinator

  Main-->>Verifier: native scheduled review of completed changed scope
  Verifier->>CLI: run packaged coordinator
  CLI-->>Verifier: structured results or semantic request
  opt supported agentic contract
    Verifier->>CLI: inspect captured evidence; complete assessment
    CLI-->>Verifier: validated final result
  end
  alt FAIL or BLOCKED
    Verifier-->>Main: relay failure-only text via blocker transport
    Main->>Main: remediate
    opt fresh independently triggered scoped recheck
      Main-->>Verifier: corrected scope, including deletions
    end
  else PASS, SUPPRESSED, or no result
    Verifier-->>Verifier: stay silent
  end
```

The user-level `WATCHDOG.yml` always keeps `default` first. The plugin inserts and owns only its marked `verifier` block immediately after `default`; independent advisors remain untouched.

`default` receives OMP's stock advisor prompt. On every setup, `verifier` copies this repository's `WATCHDOG.md` to `<agent-dir>/verifier/WATCHDOG.md`, substitutes the coordinator path derived from the installed package, and imports that generated file. The verifier model receives `bash` to select and execute applicable checks. Generic quality, scope, strategy, style, and workflow review remain with `default`; they are not verification results.

## Lifecycle

- Extension registration awaits guidance and roster reconciliation through OMP's active-profile SDK before native advisors import the generated file. Session starts also reconcile the active context; independent advisors remain untouched.
- When native OMP schedules a review, the verifier advisor binds transcript changes to their edit-owned Git checkouts and invokes the packaged automatic coordinator once per complete checkout group. It validates each request's root and changed scope before assessment and keeps recovery in that checkout. Unknown ownership stays BLOCKED; same-named files in another worktree do not establish identity. The plugin has no `agent_end` notification runner and does not select review cadence.
- `/verifier status` reports global and project roster entries plus the guidance-file path.
- `/verifier uninstall` removes only the marked verifier block and unchanged guidance file.
- The plugin does not create project configuration, local-rules templates, task agents, daemons, or custom agent loops.

## Requirement Contract

A quality standard names the expected engineering outcome or invariant and the evidence that establishes it. Diligent verification, correctness, security, and readability are complementary concerns, not a fixed universal ranking or additional checks inferred by Verifier.

A project requirement belongs in a project `WATCHDOG.yml` `verifier` entry. It must name its trigger, check id, quality standard, executable narrow check, and PASS evidence. The verifier runs the applicable command; specifying an unexecuted future check does not establish a result.

A supplied project command takes precedence over manifest lookup: its check id labels the result and does not imply that the id is installed. Coordinator `verify` is for discovered manifest ids, not a replacement for an explicitly required project command.

Requirement triggers are evaluated against newly delivered primary updates. Historical requests/results and primary-only continuation or completion reminders do not independently retrigger checks; a recurring requirement trigger or explicit recheck request does.

Automatic and manifest verification output is already structured. The coordinator's text reporter renders actual final `FAIL`/`BLOCKED` results as status/check ID, summary, optional evidence, and next check. The verifier requests `--reporter text --failures-only` and relays those results unchanged in native `advise` with severity `blocker`. A semantic result with `reviewRequest` is `PENDING` and is continued through review/evaluation, not relayed as a blocker or progress note. No paraphrase, advice, successful rows, selection metadata, or invented next check is added. JSON remains available for machines. Commands without structured output are classified against their explicit quality standard using observed command/exit/output evidence and the same readable layout. `PASS`, `SUPPRESSED`, and no applicable results call for silence. These are prompt contracts, not runtime-enforced output admission; the native UI channel remains “Advisor.”

A deliverable result needs an actual `FAIL`/`BLOCKED` classification, check id, and concrete summary. Headings and format placeholders are not results. Malformed manifest stdout is reported as a coordinator `BLOCKED` result with bounded output evidence (or an empty-stdout diagnostic) and a next check; the raw heading is not relayed alone. Missing current-turn paths, skipped automatic invocations, and empty results are inapplicable verification, not unavailable-check prerequisites, and must not produce invented blocker rows. These distinctions remain model guidance at native advice admission.

Completed failure-only coordinator output rendered as `(no output)` is expected for `PASS`, `SUPPRESSED`, and no results. Missing rendered exit metadata alone does not make it unreadable or justify a blocker or rerun. Only an observed execution error, such as an invocation diagnostic, missing executable, or timeout, warrants synthesizing a verifier-execution `BLOCKED` result. Empty stdout from a manifest entry is different: the coordinator validates that entry and emits its own complete `BLOCKED` result.

Review completion is separate from result delivery. A review with no reportable failure ends normally with a private `Complete.` response and no `advise` call only after all applicable requests reach accepted final results. Unread pages or supported context recovery are not complete. A concrete unavailable execution prerequisite instead permits an honest execution BLOCKED handoff; an unconsumed request remains unapproved, not a source verdict or PASS. In the verified OMP 18.11.1 runtime, ordinary advisor final text is not forwarded to the primary. Primary-agent status messages, acknowledgments, and requests to finish are not verifier results; they do not create a reason to send a note. The verifier reserves native delivery for complete blocker results rather than `nit`, `concern`, or unclassified notes. Native blocker delivery is not a completion veto. This remains a prompt contract.

### Advisor Silence: Plugin Policy and QA

Live OMP 18.8.9 QA with a stricter candidate prompt, loaded generated guidance, and resolved `openai-codex/gpt-6-luna` verifier produced `advise({ note: "The read is complete.", severity: "nit" })` after a read-only primary action. The acknowledgment was `Delivered.`; no failed verification justified that note under Verifier's policy. The candidate prompt-only fix was withdrawn. The evidence is recorded in [Verifier #117](https://github.com/klondikemarlen/omp-verifier/issues/117#issuecomment-6103445226). The 0.8.17 documentation misattributed this plugin-specific policy failure to an upstream defect; [Verifier #119](https://github.com/klondikemarlen/omp-verifier/issues/119) corrects that attribution and records withdrawal of the unrelated upstream comment.

The silence/blocker-only policy belongs to this plugin. The delivered `nit` demonstrates failure of Verifier's prompt contract, not an OMP admission-contract defect. OMP 18.8.9 [constructs the native `AdviseTool` directly](https://github.com/can1357/oh-my-pi/blob/v18.8.9/packages/coding-agent/src/session/session-advisors.ts#L1295-L1319), its [advisor callbacks](https://github.com/can1357/oh-my-pi/blob/v18.8.9/packages/coding-agent/src/session/session-advisors.ts#L1426-L1473) do not expose that native admission through the extension tool hook, and the [emission guard's non-blocker budget](https://github.com/can1357/oh-my-pi/blob/v18.8.9/packages/coding-agent/src/advisor/emission-guard.ts#L180-L192) has a minimum of one. These are versioned API capability facts; they do not prove a host bug or that Verifier's noise fix must be upstream. Keep this failure in Verifier unless separate evidence establishes a host-contract violation or a justified host capability request.

For future silence QA:

1. Start a fresh OMP process and verify the named verifier's resolved model and loaded generated guidance using `/advisor status` and `/advisor dump raw`.
2. Exercise read-only/no-changed-path, empty automatic-result, `PASS`, and `SUPPRESSED` cases. Inspect the verifier's own completed transcript and the delivered primary transcript, not just an unlabelled `advisor_yielded` event or a consumer-model decision.
3. Require no delivered verifier advice for each silent case. A delivered no-action note is `FAIL`, even if source checks and hypothetical decisions pass. Model quota/availability failures or missing named-advisor evidence are `BLOCKED`, not evidence of silence.
4. Preserve failure delivery: exercise an applicable deterministic failure, observe the named verifier's blocker, remediate, and observe the clean follow-up result. Do not infer cross-advisor coordination from this cycle.
5. Exercise malformed and empty manifest stdout. Compare the delivered blocker with actual failure-only reporter output: check id, malformed-result summary, observed output/empty diagnostic, and next check must remain intact. A bare heading is a failed delivery.

The historical edit/no-result probe was `BLOCKED` by primary-model `usage_limit_reached`; it is not a passing case. Releases 0.8.17 and 0.8.18 documented and corrected the evidence without changing the prompt. The result-only specialization introduced later must be judged by its own live QA; historical failure and availability limits are not converted into a passing claim.

The 0.8.19 result-only candidate passed targeted native OMP 18.10.3 QA with the configured `openai-codex/gpt-6.1-sol` verifier: read-only, empty results, PASS, and SUPPRESSED produced no delivered notes; an explicit manual requirement executed its named check; mixed FAIL/PASS delivered only the exact FAIL object; primary remediation was followed by actual PASS; and BLOCKED delivered the exact blocked result. The completed named transcript contained only two `advise` calls, both blocker/result arrays. See [PR #122's native QA record](https://github.com/klondikemarlen/omp-verifier/pull/122#issuecomment-6151394004). This proves those exercised decisions, not a hard admission gate or model-independent silence.

## Verification Capability Direction

Installed OMP plugins opt into verification through package metadata. The package-local coordinator handles discovery, selection, trusted executable checks, and semantic-request validation; the existing verifier model evaluates only explicitly supplied agentic contracts and returns final evidence through native transport. It does not own a second general review lane or configure model routes. Packages are eligible when they expose either `omp.extensions` or `pi.extensions`; declarations live under `omp.verifications`.

## Manifest Contract

An installed plugin package may declare:

```json
{
  "omp": {
    "extensions": ["./omp-plugin/index.js"],
    "verifications": [{
      "id": "publisher:check-id",
      "label": "Human label",
      "description": "What the check proves",
      "entry": "./verifications/check-id.mjs",
      "timeoutMs": 30000
    }]
  }
}
```

An entry without `mode` is a package-relative `.mjs` module. The verifier executes it with the active project as its working directory and expects one JSON result:

```json
{
  "status": "PASS",
  "summary": "The requirement is satisfied",
  "evidence": "Observed evidence",
  "nextCheck": "Optional smallest follow-up check"
}
```

`PASS`, `FAIL`, and `BLOCKED` are the only valid statuses. Valid structured `FAIL` and `BLOCKED` results survive nonzero exits when stderr is empty. Invalid manifests, duplicate IDs, path traversal, missing entries, timeouts, other non-zero exits, oversized output, malformed JSON, and missing prerequisites fail closed as `BLOCKED`; none may become `PASS`.

“All checks” means all valid checks explicitly declared by installed plugin manifests. It does not mean scanning remote repositories, guessing from tool names, or running package-maintainer `scripts/verify-*.mjs` files. Verification entries are trusted installed code, not a sandbox; the verifier accepts no model-supplied command or executable path.

The public commands are:

```text
/verifier checks
/verifier verify
/verifier verify <check-id...>
```

With no compatible manifests installed, `/verifier checks` reports `none installed` and `/verifier verify` returns `BLOCKED`. Existing `/verifier`, `/verifier status`, `/verifier uninstall`, advisor setup, and guidance ownership remain independent of this optional capability.

The packaged CLI also exposes `checks` and `verify [<check-id>...]` to the `bash`-only advisor. By default, `checks` returns a JSON object with public check metadata (`id`, `label`, `description`, optional `pathTriggers`) and `blockedResults`; it does not execute entries. `verify` returns the existing result array, shares manual execution with `/verifier verify`, and runs only exact requested IDs when supplied. Both commands also support `--reporter text`. The model selects named checks only for explicit applicable requirements, not as a catch-all review substitute.

## Agentic Standards Contract

An entry may instead declare `mode: "agentic"` and a package-relative JSON `contract`, with no dummy executable. The [README declaration](../../README.md#supplied-standards-verification) shows the manifest shape. Contract version 1 requires:

```json
{
  "version": 1,
  "standardId": "publisher:check-id",
  "source": "./docs/standard.md#boundary",
  "gold": "Each changed boundary owns a meaningful invariant or independently changing responsibility.",
  "requiredContext": ["changed-code", "callers", "siblings", "project-guidance"],
  "rubric": [{
    "id": "boundary-ownership",
    "question": "Which current source demonstrates the boundary's meaningful ownership?"
  }]
}
```

`standardId` must match the manifest ID. `source` identifies a maintained file and optional Markdown heading fragment inside the installed package. Contract and source paths are checked after realpath resolution; unsupported modes, versions, context types, missing sources, or invalid fragments are BLOCKED with the actual check ID. The provider owns policy and its quality standard/rubric; the runtime does not derive semantic policy from arbitrary prose or metrics.

**Versioned terminology migration:** version 1 still requires `gold` in provider contracts, review payloads, and result `standard` objects. It means quality standard; it is not an optional alias. This release changes readable labels and prompting, not that wire protocol. Version 2 with `qualityStandard` is planned, not supported or activated:

1. Inventory every declared provider and direct request/result consumer before cutover, including project-owned providers. The known supplied provider is MSSRT; its [terminology release #528](https://github.com/klondikemarlen/marlens-skills-rules-and-tools/issues/528) deliberately retained version 1. Coordinate the paired runtime/provider work through [Verifier #137](https://github.com/klondikemarlen/omp-verifier/issues/137), preserving standard IDs, sources, required context, rubrics, project precedence, suppressions, freshness, and statuses.
2. Prepare matching reviewed runtime and provider releases, migrate all direct consumers and fixtures to the version-2 field, and specify their minimum paired versions and installation order. Require a verified paired upgrade before a new OMP process assesses version-2 contracts; do not publish a one-sided rename that leaves installed required checks BLOCKED. No indefinite dual-name shim is planned.
3. Verify discovery, review, assessment, JSON/text reporting, stale/replay rejection, suppression, and native FAIL → correction → fresh PASS with the matching released artifacts. Old runtimes must continue to reject unsupported version 2 honestly. Only a separately coordinated release may activate that protocol cutover; current version-1 providers remain usable unchanged.

The protocol uses the same coordinator and named verifier advisor:

1. `automatic` or `verify` prepares a fresh request and returns status `PENDING` with `reviewRequest`, both when the review is ready and when recoverable context is still needed. Successful preparation exits `0`: it supplies review work, not a source verdict or approval. A final `FAIL`/`BLOCKED` result exits `1`. CLI text output with exactly one pending result presents bounded page `0` immediately and records its delivery; mixed results keep separate request handles. JSON remains unchanged for requests not enrolled in text paging.
2. `review <request-file>` returns current captured evidence, scope, provider source, quality standard, and rubric as a full pretty-printed JSON export. Provider source `text` is an array of original lines, while project-record `content` maps original one-based line numbers to exact source text. Use those keys in citations rather than counting JSON entries. `review ... --reporter text [--page <index>]` exposes bounded JSON fragments for model/human inspection, starting at page `0`. The first bounded text presentation enrolls that request; each valid served page records the request path/ID, canonical text-view fingerprint, index, and count. An enrolled request may be evaluated only after every page has been served. If any index is missing, `evaluate` ignores its draft assessment and remains `PENDING`, returning `reviewProgress.nextPage` (the first missing index) and `missingPages`; the CLI text response presents and records that next page immediately. The advisor must inspect every page before judging the full scope: page calls and metadata are delivery/accounting, not proof of comprehension or evidence of scope. Metadata such as matches, evaluation, or review progress does not change the canonical evidence view used for page accounting. JSON-only/API consumers that have not enrolled retain their existing behavior, but switching to JSON after text enrollment cannot bypass the outstanding pages. Page delivery neither renews nor consumes the request.
   `review ... --reporter text --context <project-relative-path>` captures targeted additional files and supersedes the earlier request ID. For a bounded chunk, use a shell-quoted selector such as `--context 'api/tests/README.md#L130-L150'`; repeated selectors retain separate chunks of the same file. Ranged selectors replace a prior whole-file request for that path. Recovery starts on page `0`; read later pages from the renewed path without context options. Invalid page arguments are rejected before recovery can renew a request. Paging does not relax capture, freshness, citations, or the rubric, and does not combine independent per-page verdicts.
   Display lines wrap at 600 UTF-8 bytes, with a backslash at each inserted line break so column limits do not hide source. Remove each backslash-newline continuation without inserting a newline to reconstruct the JSON fragment or execute a page footer's literal `Next command`. Ordinary JSON line breaks remain. Byte offsets address the unwrapped JSON view, and content keys remain original source line numbers. The formatted page budget includes wrapping overhead. Full JSON export does not add display continuations.
   Pages presented during preparation or context recovery already count as delivered receipts, so continue from their reported next index rather than requesting page `0` again. Inspect their content as well: delivery accounting does not prove comprehension. On a non-final page, execute its exact returned next-page command; on the final page, execute its exact returned evaluate command with literal assessment JSON on stdin. Remaining readable pages are advisor work, not an unavailable prerequisite or native blocker. Do not deliver progress, native blocker advice, or `Complete.` before an accepted final result. Batch currently known material files/ranges and runner evidence in one recovery call using repeated `--context`/`--caller-context` selectors. Recover an established gap before fetching more pages of an intermediate request that will be replaced, then inspect every page of the final current request. This reuses current captured evidence without skipping required context, weakening freshness, or treating readiness as PASS.
3. The existing model assesses the supplied rubric using actual changed code and relevant project context. Project-local architecture takes precedence. A small meaningful invariant may pass; a trivial extraction is not justified by naming or file size alone.
4. `evaluate <request-file> --assessment -` reads an assessment from stdin. It requires the actual current `requestId`, `status` (`PASS`, `FAIL`, or `BLOCKED`), non-empty `summary` and `rationale`, and `citations` containing project-relative `path`, original one-based `line`, and exact source `quote`. PASS/FAIL require a matching citation in the changed scope; BLOCKED may explain unavailable evidence without a source citation. Supply the smallest corrective `nextCheck` for failures or blocks.
5. The runtime checks the current request, provider/standard hashes, project context, citations, and (for enrolled text views) complete page-delivery accounting, then consumes an accepted request. Missing page receipts keep the request PENDING rather than admitting the draft assessment. Current source/provider freshness validation still runs before page-accounting admission; once the pages are complete, the normal citation guards apply. Delivery receipts do not substitute for freshness, citations, or semantic judgment. Final results preserve the standard ID/source and quality standard. Only final FAIL/BLOCKED results are delivered through native blocker transport; PASS stays private. Correct the source or apply an allowed bounded reasoned exception, then prepare a fresh evaluation. A planned check, consumed request, superseded assessment, or earlier PASS cannot clear a later change. Native blocker advice is the correction channel, not a native completion veto; this workflow does not fix or guarantee admission for [#150](https://github.com/klondikemarlen/omp-verifier/issues/150).

Supersession is an operation lifecycle, not a source defect. Under the same per-check lock, a late `review` or `evaluate` returns the validated pending replacement as `reviewRequest`; every supported result carrying that handle is `PENDING`, whether ready or awaiting recoverable context. `evaluation.requestId` identifies the rejected operation and `evaluation.supersededBy` identifies the current request. Old selectors and assessments are not applied. Reconfirm the complete edit-owned scope, read every replacement page starting at `0`, then assess its current ID; the new request identity starts fresh page accounting. Text review restarts at page `0` even when the obsolete operation requested a later page. If the current request is already consumed, return non-verdict `SUPERSEDED` without replaying its verdict. CLI failure-only output retains both `PENDING` and `SUPERSEDED` for recovery; neither is native blocker advice or evidence of PASS. Current provider/source freshness and tamper validation still run; missing state and genuine final prerequisites can produce `BLOCKED` without `reviewRequest`.

Automatic recovery establishes current applicability before treating a saved provider failure as a current prerequisite. The advisor reconciles candidate paths against the evidenced delivery base and tip, preserving retained changes and authenticated deletions but excluding temporary additions absent from both. A fresh `automatic` invocation then discovers the current provider and selected contracts. Changed providers require new evidence and assessment; an empty selection ends silently without approving the old request, while a current required missing provider remains BLOCKED. This is advisor lifecycle guidance, not weaker runtime freshness validation; explicit named checks and direct stale-request diagnostics retain their existing semantics.

A policy interruption during `review` or `evaluate` leaves the assessment obligation PENDING; policy text, unusable JSON, and a private `Complete.` do not establish completion. The advisor follows the applicable policy, then resumes the targeted operation with current evidence and request identity. When no usable replacement is returned and the applicable scope lacks an observed current final result, an unusable, superseded, or already-consumed request requires fresh preparation of the same complete scope, not reuse of the old assessment. If an actual execution prerequisite prevents completion, report its observed diagnostic and smallest next check as a concrete execution `BLOCKED`, not a source verdict. A retained request handle does not make that prerequisite available or establish approval. Unread pages and recoverable path-copy errors remain actionable pending work. This is continuation guidance, not a policy bypass or native completion veto.

Recovery belongs to the request's `scope.repositoryRoot` and complete `scope.changedPaths`, not a stacked child's checkout or remembered file list. Inspect current source and captured directory membership before selecting dependencies. An absent optional sibling explicitly requested by mistake is a selection error, not evidence that automatic discovery failed or the application needs a phantom file. Additional `review --context` calls retain earlier selectors. Remove an erroneous selection explicitly with repeatable `--remove-context '<exact-retained-selector>'`, adding valid replacement ranges with `--context` or `--caller-context` in the same call. Removal applies to both retained selector lists before additions; other selections and the complete changed scope, including authenticated deletions, remain intact. Unknown removals fail without changing the current request. A successful edit captures current evidence under a new request ID and resets page receipts; inspect the returned page `0` and every remaining page before assessment. Freshness, full-source identity, citation, and evidence limits are unchanged; ranges are not clamped and partial coverage cannot establish PASS. A dependency established by current source or the supplied rubric remains required even when absent: keep the review PENDING while recoverable evidence is captured and use final BLOCKED without `reviewRequest` only when it cannot be recovered. Never omit a required dependency to obtain PASS.

Capture prioritizes changed source and explicitly requested files/ranges, then applicable owning/ancestor guidance, then optional caller/sibling evidence. The bounded inventory prioritizes that scope and nearby source before unrelated files. Changed paths and explicit material context extend the required guidance boundary; heuristic filename-matched callers are candidates, not proof that unrelated subtree guidance is mandatory. Promote any material dependency with `review --context` before judging it so its owning guidance is captured too. `context.guidanceRequirements` names each guide's `requiredBy` boundaries and capture failure. `context.evidenceBudget` names the exact byte/file ceilings, admitted records, usage, and rejected records; recoverable required evidence keeps the request PENDING, while evidence that cannot coexist within supported limits yields final BLOCKED without `reviewRequest`. Explicit excerpts are not recopied into caller/sibling groups, and optional whole-file records respect the same 16 KB evidence limit.

A project guide already admitted as complete changed-code evidence also satisfies its owning-guidance requirement; the coordinator does not recopy it into a separate guidance record. Partial, unavailable, deleted, or over-budget changed source cannot discharge that requirement. Recover the complete changed guide with bounded original-line selectors before assessment; freshness and citation checks still use its captured source.

Confirmed deletions retain their prior captured or Git source, including a previously observed untracked helper removed during correction. With an empty capture cache, committed deletions recover the exact source from the first parent of the latest deletion on HEAD's first-parent history, including merge deletions and later unrelated commits. Git lookup has a five-second command deadline and the request's whole changed-source cap (16,000 bytes by default). Oversized authenticated source has a size diagnostic distinct from unavailable history; unavailable or shallow history, binary source, and absent files without authenticated prior source cannot establish a source verdict. Retained deleted text counts against the same aggregate byte/file budget as present source. Original-line citations and `previousSha256` identify deleted source without restoring it.

Retrieval limits remain operational bounds, not semantic verdicts: up to 1,200 inventory files and 8 MB of inventory reads; ordinarily 40 distinct evidence files and 256,000 bytes of captured evidence; 16 KB per whole-file record or requested excerpt. When the distinct union of changed paths, explicit material-context paths, and their owning guidance exceeds 40, capture selects a 256-file / 1,024,000-byte large-scope budget before admission. Required records also select that same bounded larger tier when their admitted content would cross 256,000 bytes, including complete recovered chunks and authenticated deleted source. Heuristic callers and optional siblings cannot trigger growth. `context.evidenceBudget.requiredFiles` reports the required-path cardinality alongside the effective ceilings, usage, and exact rejections. Required-scope capacity diagnostics distinguish those failures from optional omissions: recover material ranges with `review --context` when they can coexist, retain complete changed-source coverage, and keep the result PENDING while supported recovery remains possible. Required evidence beyond the larger byte or file ceiling remains unapproved; do not split the scope or drop required records. Up to 30 explicit selectors may each request at most 500 original lines; ranged identity retains the 256 KB per-source ceiling. Bare explicit files retain the 16 KB limit; oversized applicable guides initially expose up to 120 lines when that excerpt fits. One current request and verdict cover the complete scope; larger capture never implies PASS.

Fresh `automatic` and `verify` captures accept `--max-source-bytes <bytes>` as an explicit one-off whole changed-source cap, including historical Git-backed deletions. Values must be decimal safe integers from 16,000 through 256,000; for example, a 32,768-byte cap admits a complete 16,229-byte committed deletion without restoring it. The effective value is recorded in `scope.maxSourceBytes` and `context.evidenceBudget.maxSourceBytes`, bound to the request's identity/freshness, and preserved through context renewal and assessment. `review`, `evaluate`, and `checks` cannot change it. A later independent preparation without the flag returns to 16,000, even when an earlier larger deletion remains cached. Ranged live-source reads still have the 256,000-byte source ceiling and 16,000-byte excerpt limit; explicit context, guidance/caller discovery, aggregate byte/file budgets, and all unrelated safety limits are unchanged. The exception permits capture, never semantic approval.

`context.siblingInventory` records each changed parent directory's source-file list and enumeration completeness independently of the global source inventory. A completely inspected directory with no other source files supplies valid empty-sibling evidence even when unrelated repository inventory is truncated. Directory enumeration shares a separate 1,200-entry budget across changed directories, counts non-source entries, stays inside the project, and reports unreadable or uninspected boundaries as incomplete. Nonempty boundaries still require captured sibling evidence or explicit material source context, not every listed file's contents. Scoped sibling completeness never establishes global caller coverage; directory membership is included in request freshness validation.

After required source and guidance, capture reserves one available sibling representative per changed directory before admitting broad filename-matched callers and remaining siblings. Explicitly captured source can satisfy that reservation without duplicate records. `context.siblings` reports `none-found` only after complete empty-directory discovery; `not-captured` means siblings exist but no source was admitted, `unavailable` means discovery could not establish absence, and `captured-elsewhere` points to source already present in targeted or caller records. Arrays contain directly captured sibling records. Missing-context diagnostics name incomplete directories and candidate paths; `context.evidenceBudget.rejections` retains file-count, aggregate-byte, and per-file capture-limit reasons. Recover material source with `review --context <path[#Lstart-Lend]>` while retaining the complete changed scope; clearing acquisition gaps does not itself complete semantic assessment.

Caller recovery distinguishes source importers from runtime entrypoints. `review <request-file> --caller-context <project-relative-path[#Lstart-Lend]>` labels captured runner configuration/discovery or caller source explicitly, without requiring a literal changed-filename match. Use real project files such as a runner's package script plus its discovery configuration; do not add artificial importers or documentation. The selectors share the existing 30-selector, source, record, and total-evidence budgets with `--context`, renew the request ID, extend owning guidance, and remain in freshness validation across later renewals. A changed file cannot serve as its own caller evidence.

This supplies material context for the model's scoped applicability judgment, not an automatic entrypoint/no-caller verdict. The model must establish discovery/applicability from that actual source, explain whether source callers are material, and keep the request PENDING while recoverable material caller evidence is obtained. If required caller evidence cannot be recovered, return final BLOCKED without `reviewRequest`. PASS/FAIL using explicit caller context require exact citations to both the changed scope and captured caller/runtime source. `context.callerRetrieval` reports the 1,200-file and 8 MB read bounds, inspected/omitted counts, up to 30 omitted path examples, exact unreadable-source reasons, and recovery instructions. `sourceInventory.complete` remains independent and false when global acquisition is incomplete; a runtime entrypoint assessment never establishes globally complete caller coverage.

Partial records expose `startLine`, full `lineCount`, `partial`, and `omittedRanges`. Full-source hashes invalidate a request when source outside an excerpt changes, and citations must match a captured original line in one of its chunks. Omitted optional evidence and incomplete inventories remain explicit; neither implies complete caller or guidance coverage. `evidenceTruncated.siblings` or rejected optional siblings alone do not establish a semantic blocker. Select material files/ranges with `--context` and real runner source with `--caller-context`, then inspect the renewed `missingContext`, guidance requirements, and evidence-budget records before assessment. For a migration, prior schema and a relevant recent backfill can be material even when unrelated historical migrations fill the initial window. A budget blocker identifies the particular material evidence that remains unavailable after targeted recovery and why the rubric needs it; it does not demand a larger budget or new runtime when current selection suffices. Recoverable required evidence remains PENDING; evidence that cannot be recovered is final BLOCKED without `reviewRequest`. An empty `missingContext` permits judgment rather than establishing PASS.

An oversized required changed file initially remains unavailable. Recover it with repeated `review --context 'src/module.js#L1-L120'` selectors covering all original lines. `context.changedCodeCoverage` exposes each recovered path's `lineCount`, `coveredRanges`, `omittedRanges`, and `complete` state. Only complete admitted coverage clears the required changed-code gap; a valid citation or a union with even one omitted line cannot establish PASS/FAIL. Each admitted chunk retains its original line numbers and the full current source hash. Recovery neither raises any retrieval ceiling nor changes the supplied rubric; the request stays PENDING while supported recovery can complete coverage and yields final BLOCKED without `reviewRequest` if the source cannot fit.

Requests are private, atomically written, per-project operational cache, not a knowledge store or reusable PASS cache. Per-check locks serialize overlapping preparation/completion. A busy or abandoned lock is BLOCKED; it is not automatically stolen. Only remove a reported abandoned lock after confirming the owner PID recorded in it has exited.

### Transient Source Handoff

A temporary smoke script can be executed and cleaned up before the first model assessment. Set `coordinator` to the installed `bin/omp-verifier.js` path shown in the generated `<agent-dir>/verifier/WATCHDOG.md`; the package's CLI name need not be on the shell's PATH. Before deleting the script, explicitly prepare its source:

```bash
node "$coordinator" automatic 'api/.review-smoke.ts' --reporter json
```

Run this after the script's final edit and execution, immediately before cleanup. Inspect the semantic result's `reviewRequest.context.changedCode`: it must contain that exact path's complete whole-file source record, not an unavailable or partial record. This existing handoff requires a single whole-file record within the 16 KB bound; recovered ranges are not a deletion snapshot. A semantic result carrying `reviewRequest` is `PENDING` whether ready or awaiting recoverable context; it is not a semantic failure or PASS. Preserve any actual deterministic final FAIL/BLOCKED results returned alongside it. Do not clean up source that has not been captured completely within the existing bounds.

Remove the disposable file using the project's normal cleanup, then let the final changed-turn check run `automatic` for that same path. For an explicit recheck, run the same command again. It prepares a new request, retaining the authenticated prior source as `state: "deleted"` with its `previousSha256`. Read every page, continue using the exact footer `Next command`, and assess this new request using original source-line citations; do not evaluate the superseded pre-cleanup request. No earlier model review, source restoration, broader path selection, or advisor-cadence change is required.

This handoff uses the existing private per-project, per-check request slot, not a durable source archive. Capture all transient paths needed by that check together and do not interleave another preparation that drops them before the final capture. Re-capture after any source edit while the file still exists. Missing, tampered, superseded, incomplete, or pruned prior evidence cannot establish deletion provenance; an absent path without trusted prior or Git source remains BLOCKED. Execution success and a clean Git diff never replace the final semantic assessment. This documents source continuity, not a native completion veto or a fix/guarantee for #150.

## Completion Boundary

This integration provides evidence-backed correction through the existing advisor path; it does not implement an atomic completion gate. A user request starts an agent run, which may contain multiple model/tool cycles. Final yield is the attempted return of control to the user, not every tool-call boundary.

Native OMP 18.12.6 supports synchronous final review through a roster entry with `reviewMode: agent-end`, `reviewInterval: 1`, and `syncBacklog: strict`. The first two controls schedule a review of the accumulated run at final yield; `strict` waits for that scheduled review without the numeric policy's 30-second timeout. These are OMP-owned configuration controls, not defaults selected by this plugin. Strict-final-review-only configuration is a useful reduced capability, not a current-PASS completion gate.

The [native catch-up contract](https://github.com/can1357/oh-my-pi/blob/v18.12.6/docs/advisor-watchdog.md#catch-up-with-advisorsyncbacklog) releases strict waiters on abort, failure, quota pause, session transition, or disposal. Waiting for a review therefore does not certify approval: a missing or failed assessment cannot establish PASS.

OMP 18.12.6 deliberately [captures advisor-triggered repair continuations without scheduling another review](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-advisors.ts#L580-L710) to prevent advisor→primary→advisor cascades. A fresh independently triggered run, such as an explicit scoped recheck request, is needed to schedule the next assessment. Waiting alone cannot turn that repair into a verified PASS. Recheck the actual corrected scope, including deleted source; do not substitute unrelated working-tree paths or reuse an earlier result.

[Verifier #150](https://github.com/klondikemarlen/omp-verifier/issues/150) and [OMP #14597](https://github.com/can1357/oh-my-pi/issues/14597) track the missing native policy: opt-in reassessment at repaired completion attempts, a current clean outcome before settlement, and explicit handling of unavailable reviews while preserving cancellation. The [18.12.6 roster schema](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/advisor/config.ts#L67-L78) exposes cadence and catch-up controls, not that completion policy. Verification contracts and results remain package-owned; selecting and reconciling supported advisor policy belongs to the OMP configuration owner.

An extension-owned integration is a different route. OMP exposes a [`session_stop` decision](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/session/agent-session.ts#L5148-L5184) whose explicit `decision: "block"` is exempt from the ordinary continuation cap. [OMP #15422](https://github.com/can1357/oh-my-pi/issues/15422) requests extension-observable advisor completion/outcomes; it is not the sole prerequisite for an OMP-owned advisor policy. Verifier registers no stop veto, transcript polling, or second model runtime.

Native blocker delivery followed by primary correction and a fresh PASS proves the exercised correction cycle, not that every unverified primary completion is prevented. Advisor scheduling, model availability, and settlement remain OMP-owned.

## Discovery and Execution Inputs

The plugin's command adapter takes the active project directory and OMP's verification-package directory from the session context. The coordinator derives its default installed-package directory from the installed Verifier package or `PI_CODING_AGENT_DIR`.

Discovery prefers the plugin manager registry at the parent `package.json` when it is named `omp-plugins` and has an object-valued `dependencies` field; otherwise it scans direct and scoped package directories. A candidate must expose an `omp.extensions` or `pi.extensions` entry and declare `omp.verifications`. Verifier does not scan remote repositories, project source trees, arbitrary `verify-*` scripts, or undeclared package entries.

Each manifest entry has a namespaced lowercase `id`, `label`, `description`, and optional non-empty `pathTriggers`. Executable entries have a package-relative `.mjs` `entry` and optional bounded `timeoutMs` (30 seconds by default, at most 120 seconds); the runner invokes trusted installed code with `node` and no shell. Agentic entries have explicit `mode` and `contract` instead. Declared assets must remain inside their package after resolving symlinks.

Selection differs by interface:

- `/verifier checks` lists valid installed checks and any manifest discovery blocks.
- `/verifier verify` runs every discovered check; `/verifier verify <id...>` runs only those exact IDs. `pathTriggers` do not restrict explicit runs. With no checks installed, `verify` reports `BLOCKED`.
- The automatic coordinator receives only paths changed by the current completed run, as project-relative arguments. Matching manifest `pathTriggers` or bounded project `requirements` select installed checks and record each selected path and trigger. Checks selected by neither remain manual-only. `automatic --worktree` is a separate explicit mode that derives all current Git-worktree changes.

Automatic executable entries receive matching paths as the `OMP_VERIFIER_CHANGED_PATHS` JSON-array environment variable. The runner removes any inherited value first; manual executable checks do not receive it. Other environment variables are inherited. Agentic entries capture matching current source instead. The coordinator applies `.omp-verifier.json` from the repository root and affected ancestors: bounded `requirements` select named checks and make missing providers observable, while bounded `suppressions` preserve an explicit reason and optional valid expiry. A suppression may name an installed check or an explicitly required absent provider. Invalid/expired configuration and other unknown IDs produce BLOCKED; an exception is SUPPRESSED, never PASS.

## Result and Evidence Semantics

An entry writes one JSON object to stdout with a required `status` (`PASS`, `FAIL`, or `BLOCKED`) and non-empty `summary`; `evidence` and `nextCheck` are optional. The runner bounds output and text fields, validates the shape, and enforces the manifest timeout. Malformed output, stderr, timeout, missing entry, invalid manifest, or other unsuccessful execution cannot become `PASS`. Structured `FAIL` and `BLOCKED` results retain their summary, evidence, and next check when valid and stderr is empty, including on a non-zero process exit. A structured `PASS` with a nonzero exit remains `BLOCKED`.

Each result has an `id`, `status`, and `summary`, plus optional `evidence` and `nextCheck`; automatic selected or suppressed results include `matches` carrying changed `path` and matched `trigger`. Completed semantic results also carry `standard` (ID/source/quality standard, with the version-1 `gold` field) and `evaluation` (mode/request ID). Every supported semantic result with `reviewRequest` has status `PENDING`, whether assessment is ready or awaits recoverable context.

| Outcome | Meaning and Verifier behavior |
| --- | --- |
| `PENDING` | A supported semantic result carries `reviewRequest`; assessment remains outstanding, including while required context is being recovered. Continue the review; this is neither FAIL nor BLOCKED. |
| `PASS` | The executable reported its quality standard met, or a current semantic assessment was admitted against validated evidence. This is not independent proof of overall code quality. |
| `FAIL` | The declared check reported a violation. The verifier relays the text reporter's actual failing result through native `blocker` transport. |
| `BLOCKED` | The final result has no `reviewRequest` field; this result shape does not mean private request files or cached state were physically deleted. The check could not establish PASS/FAIL or discovery/execution/result validation failed. The verifier relays the text reporter's available result, without inventing evidence or remediation. |
| `SUPPRESSED` | Verifier matched a valid bounded suppression and did not run the check for that path. This is not a PASS; automatic guidance stays silent. |
| No result | No automatic check applied (or there were no changed paths). This is not a PASS; automatic guidance stays silent. |

Automatic and manual CLI execution defaults to a JSON result array; `--reporter json` is explicit, and `--reporter text` renders readable results. `--failures-only` retains `PENDING` and `SUPERSEDED` lifecycle results alongside final `FAIL`/`BLOCKED`; successful results are filtered. Text omits selection metadata, preserves existing multiline structure, wraps long prose at word boundaries, and shares its formatter with slash commands. Any final `FAIL`/`BLOCKED` exits `1`; otherwise successful execution exits `0`, including PENDING preparation, review retrieval, and missing-page recovery. Invocation errors exit `2`. Exit `0` is transport/execution success, not a quality verdict: consumers must inspect each result status and complete all PENDING assessments. Discovery defaults to a JSON inventory and exits `1` for discovery blocks, otherwise `0`. Failed retrieval still returns final BLOCKED/exit `1`. `evaluate` uses the normal result reporters.

**Interpretation limit:** PASS from a narrow manifest check proves only that the check entry returned a valid PASS result for its declared contract. It is not a code-quality certification, an approval of unrelated behavior, or proof that generic review concerns were checked.

## Ownership Boundaries

- **OMP Verifier** checks applicable current changed code against declared verification contracts. It owns its marked advisor setup/cleanup, commands, manifest discovery, path selection, bounded exceptions, trusted executable invocation, current semantic evidence/request validation, result reporting, and the existing model's contract-assessment guidance.
- **A policy/check-owning package** owns the standard, quality standard, applicability, and executable implementation or semantic rubric. [Marlens Skills, Rules, and Tools (MSSRT)](https://github.com/klondikemarlen/marlens-skills-rules-and-tools) supplies reusable Marlen coding guidance and declared checks/contracts. Verifier does not invent policy or infer checks from prose, filenames, or tool names.
- **A project** owns explicit command requirements in project `WATCHDOG.yml`, bounded ID/path `requirements` and reasoned exceptions in `.omp-verifier.json`, and any project-specific check package. A supplied command names its trigger, quality standard, narrow check, and PASS evidence.
- **OMP's default advisor** retains generic code quality, robustness, strategy, scope, style, and workflow review. Verifier's model runs applicable checks and returns their evidence, not general advice.
- **OMP advisor runtime and configuration** own model resolution, scheduling, and actual advisor interaction with the primary agent. Verifier does not choose or rewrite model/provider routes; live correction claims require the verifier model to resolve and an observed blocker/remediation cycle.
- **OMP Learner** (the [OMP Learner repository](https://github.com/klondikemarlen/omp-learner)) identifies human corrections, checks whether equivalent guidance at the same scope is already tracked, and routes genuinely missing learning to its owner through reviewable proposals. It does not verify code adherence. An ordinary already-covered correction completes this coverage responsibility; a code violation alone does not establish a Learner defect.

Tracked guidance, a supplied verification contract, and an observed current verification result are distinct facts. Neither Learner's `covered` result nor a ticket or memory acknowledgment establishes code compliance, activates a check, or replaces Verifier's current result. A new Learner ticket or live handoff is not required for each verification run.

The policy owner supplies the accepted rule and explicit check or rubric; Verifier selects applicable checks from current changed paths and project requirements, respecting bounded exceptions. Supported checks establish evidence-backed PASS/FAIL; a recoverable required-context gap remains PENDING with `reviewRequest`, while a missing provider, unsupported mode, or insufficient evidence that cannot be recovered yields final BLOCKED without a review handle. Mere prose does not become executable policy. Successful, suppressed, and no-action results remain silent.

### Tracked Rule Versus Verified Code

Consider an account-summary presenter whose only new extraction is an `accountName(account)` helper returning `account.name`, with no separate formatting policy or meaningful responsibility:

1. A human correction says to keep that direct field selection in the presenter. Learner finds the equivalent module-boundary rule already tracked in MSSRT and reports covered guidance. Its ordinary coverage responsibility is complete.
2. Verifier independently evaluates the changed presenter and helper against the installed module-boundary contract, with caller, sibling, and project context. A needless boundary yields FAIL with the actual standard/source, changed location, failed quality standard, and evidence—not a claim that the rule is missing.
3. The primary agent restores direct selection and deletes the helper. A fresh explicit scoped recheck must assess that corrected source and the removed helper; the earlier failure or an older PASS cannot establish the new result.
4. An observed fresh PASS establishes only that the current scoped contract passed and stays private. Missing required evidence remains BLOCKED rather than being replaced by Learner's coverage result.

This is an intended-behavior example, not additional observed release evidence. [Issue #130](https://github.com/klondikemarlen/omp-verifier/issues/130) records the completed standards-verification delivery; its closure does not establish the broader completion gate tracked by #150. See [Completion Boundary](#completion-boundary) for the native policy distinction and required fresh recheck.

## Implementation and Proof Map

| Contract | Implementation source | Focused evidence |
| --- | --- | --- |
| Advisor command registration, completion, human-readable command output, and pre-import/session setup | [`omp-plugin/index.js`](../../omp-plugin/index.js#L33) | [`test/verifier-plugin.test.js`](../../test/verifier-plugin.test.js#L20) covers completion, handlers, and setup. |
| Marked global roster block and generated guidance lifecycle | [`omp-plugin/global-verifier.js`](../../omp-plugin/global-verifier.js#L149) | [`test/verifier-plugin.test.js`](../../test/verifier-plugin.test.js#L300) covers setup, preserving independent advisors, status, cleanup, and customized guidance. |
| Registry/fallback discovery, manifest validation, execution and result normalization, path triggers, and suppressions | [`omp-plugin/verifications.js`](../../omp-plugin/verifications.js#L161) | [`test/verifier-plugin.test.js`](../../test/verifier-plugin.test.js#L27) exercises declared-registry discovery, malformed/duplicate/unsafe manifests and results, path selection, suppressions, and slash-command output. |
| Packaged coordinator discovery, named execution, automatic arguments, JSON output, and process exit status | [`bin/omp-verifier.js`](../../bin/omp-verifier.js) | [`test/verifications-runtime.test.js`](../../test/verifications-runtime.test.js) exercises empty output, current-turn versus stale paths, and Node execution; [`test/verification-cli.test.js`](../../test/verification-cli.test.js) covers selected-check isolation and unavailable named checks. |
| Human-readable status, evidence, next check, and inventory reporting | [`omp-plugin/reporters.js`](../../omp-plugin/reporters.js) | [`test/reporters.test.js`](../../test/reporters.test.js) and [`test/reporter-cli.test.js`](../../test/reporter-cli.test.js) cover multiline evidence, mixed-result filtering, JSON metadata, successful silence, unavailable checks, and invalid reporter selection. |
| Current-turn model input, check-result-only output, and first-session generated command | [`WATCHDOG.md`](../../WATCHDOG.md) | [`test/advisor-correction.test.js`](../../test/advisor-correction.test.js) registers the extension before any session-start event, then executes current generated guidance through a real shell under a shell-sensitive path and observes readable FAIL then silent PASS. Live QA must additionally inspect first-import guidance identity and named-advisor execution/delivery; source-text assertions cannot prove this policy. |
| Supplied semantic contract/source validation and current evidence capture | [`omp-plugin/semantic-contracts.js`](../../omp-plugin/semantic-contracts.js), [`omp-plugin/semantic-context.js`](../../omp-plugin/semantic-context.js) | [`test/semantic-evaluations.test.js`](../../test/semantic-evaluations.test.js) covers unavailable guidance/context, README and source changes, exact citations, and deleted untracked source. |
| Private request identity, freshness, consumption, overlap, and required-provider handling | [`omp-plugin/semantic-evaluations.js`](../../omp-plugin/semantic-evaluations.js), [`omp-plugin/verifications.js`](../../omp-plugin/verifications.js) | The semantic regression suite covers tampering, replay, supersession, overlapping requests, missing providers, and bounded exceptions. Native QA separately proves actual model judgment and primary correction. |

These tests prove only the cases they exercise. The advisor-correction test does not run a live OMP advisor, prove model resolution, or observe primary-agent remediation. The release smoke in the [README](../../README.md#development-and-release) requires those live observations before claiming correction behavior; `/advisor status` is the runtime-state authority. A settled RPC response alone does not establish that a named advisor completed its review; inspect its completed transcript and delivered primary result.

The implementation is the authority for current behavior, tests are evidence for their explicit scenarios, and project docs describe intended contracts. A passing test suite is not proof of uncovered behavior.

### Native QA Evidence Attribution

The [release smoke](../../README.md#development-and-release) proves one current named-verifier scenario at a time. Save its named-advisor transcript baseline and primary/event baseline before triggering work. Associate the actual selected paths, check ID, current semantic request ID where applicable, final coordinator output, completed review, native blocker, primary remediation, and fresh corrected-scope result. Include removed source in that recheck. An earlier private final, unrelated result, or settled primary RPC prompt cannot substitute for current named-review completion. Conversely, named-review completion alone does not mean the primary can accept another ordinary prompt; require successful prompt admission and the preceding primary prompt's settlement.

Record the exact installed OMP/Verifier/provider versions and resolved verifier selector. Freeze synthetic source and provider inputs before the live cycle and verify their identity; a provider replacement during review correctly invalidates that request. Require actual intended-path selection: a valid PASS saying no changed files applied is no-action evidence, not proof that committed source was assessed. Use the provider's supported scope input, such as its comparison-base variable, rather than assuming manual checks receive automatic changed paths.

A status-only probe can establish RPC readiness and protocol negotiation, `/verifier` registration, the installed version and guidance, and a resolved model in `/advisor status`. These local commands can complete with `agentInvoked: false` without exercising a model request. Their success proves loading and status, not provider availability, a completed semantic assessment, or completion enforcement.

An unattended completion-gate claim needs one user request to drive FAIL → blocker → primary repair → fresh current PASS before settlement, without a follow-up work/recheck prompt. Account for unrelated continuation triggers such as unexpected-stop detection and todo reminders: their recheck can produce a valid PASS without proving that advisor-triggered repair itself schedules reassessment. Keep isolated failures and successful but differently triggered scenarios separate; the versioned reproduction and dependency record belong in #150 rather than a recurring knowledge-base status log.

Keep outcome and diagnostics in their actual scenario windows. A later continuation or unrelated provider error does not erase a completed earlier scenario. A current error without a completed current result remains FAIL/BLOCKED; no result is invented from historical success. Startup-only timeouts, mismatched installed-version assertions, rejected overlapping prompts, and incomplete PTY terminal-query responses are setup/harness failures, not semantic verdicts or general provider-outage evidence. Use an observable initialized-editor or RPC-ready barrier and answer terminal queries instead of relying on sleeps.

An explicitly authorized task-local alternate model proves only that selector's exercised behavior, not original-model-specific coverage. Preserve normal routes and configuration, record unavailable original coverage honestly, and stop diagnostics once the scoped plugin outcome and blocker are established. The shared [Real Async Runtime Barriers in Integration Tests](https://github.com/klondikemarlen/marlens-skills-rules-and-tools/blob/main/docs/references/engineering-techniques-reference.md#real-async-runtime-barriers-in-integration-tests) owns the general barrier technique. [OMP #15422](https://github.com/can1357/oh-my-pi/issues/15422) owns the requested extension-observable per-review completion/outcome handoff; transcript inspection is QA evidence, not a promise of a private-state API or a new Verifier runtime.

## Learner Promotion Path

The [OMP Learner project](https://github.com/klondikemarlen/omp-learner) captures high-confidence style and concept feedback in OMP memory and reviewable tickets. It must not silently turn an observation into executable policy. The intended promotion path is:

```text
user correction or repeated feedback
  -> learner memory and/or reviewable ticket
  -> accepted shared rule or project rule
  -> explicit deterministic manifest or versioned agentic standards contract
  -> verifier evidence
```

Deterministic checks belong in manifests when a rule has a bounded, reproducible signal. Qualitative standards remain with their guidance owner unless accepted as an explicit agentic contract with a quality standard, required context, and a rubric. A Learner guidance-coverage note proves neither that such a check exists nor that current code was evaluated; accepting a missing-verification proposal does not require adding another copy of the rule.

## Related Feature Tickets

- [OMP Verifier #82](https://github.com/klondikemarlen/omp-verifier/issues/82) — consume installed plugin verification manifests.
- [MSSRT #227](https://github.com/klondikemarlen/marlens-skills-rules-and-tools/issues/227) — expose reusable Marlen-specific checks.
- [OMP Learner #99](https://github.com/klondikemarlen/omp-learner/issues/99) — promote accepted lessons into reviewable verifier-check proposals.
- [OMP Verifier #130](https://github.com/klondikemarlen/omp-verifier/issues/130) and [MSSRT #513](https://github.com/klondikemarlen/marlens-skills-rules-and-tools/issues/513) — supplied semantic standards, current evidence, and correction/re-verification.

## Release

Release ownership runs issue → issue-named branch → linked draft PR → complete self-review → focused QA and `npm run release:check` → resolved feedback and required checks → merge commit → synchronized `main` → remote reinstall → fresh-process installed behavior.

Advisor-correction claims additionally require a resolved verifier model in `/advisor status`, a packed or remotely installed failing-check scenario, observed verifier blocker delivery, primary-agent remediation, and a clean follow-up coordinator result. `PASS`, `SUPPRESSED`, and no results must remain silent; incomplete remediation must be checked across `advisor.immuneTurns`.
