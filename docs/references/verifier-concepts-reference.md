# OMP Verifier Concepts Reference

## Product Shape

OMP Verifier uses a second advisor as the model-driven selector/executor of declared checks and evaluator of explicit supplied standards contracts. It is not another general reviewer or a replacement for OMP's default advisor.

```mermaid
sequenceDiagram
  participant Main as Primary agent
  participant Verifier as Verifier advisor
  participant CLI as Automatic coordinator

  Main-->>Verifier: completed changed turn
  Verifier->>CLI: run packaged coordinator
  CLI-->>Verifier: structured results or semantic request
  opt supported agentic contract
    Verifier->>CLI: inspect captured evidence; complete assessment
    CLI-->>Verifier: validated final result
  end
  alt FAIL or BLOCKED
    Verifier-->>Main: relay failure-only text via blocker transport
    Main-->>Verifier: remediated turn
  else PASS, SUPPRESSED, or no result
    Verifier-->>Verifier: stay silent
  end
```

The user-level `WATCHDOG.yml` always keeps `default` first. The plugin inserts and owns only its marked `verifier` block immediately after `default`; independent advisors remain untouched.

`default` receives OMP's stock advisor prompt. On every setup, `verifier` copies this repository's `WATCHDOG.md` to `<agent-dir>/verifier/WATCHDOG.md`, substitutes the coordinator path derived from the installed package, and imports that generated file. The verifier model receives `bash` to select and execute applicable checks. Generic quality, scope, strategy, style, and workflow review remain with `default`; they are not verification results.

## Lifecycle

- Extension registration awaits guidance and roster reconciliation through OMP's active-profile SDK before native advisors import the generated file. Session starts also reconcile the active context; independent advisors remain untouched.
- After a changed turn, the verifier advisor invokes the packaged automatic coordinator. The plugin has no `agent_end` notification runner.
- `/verifier status` reports global and project roster entries plus the guidance-file path.
- `/verifier uninstall` removes only the marked verifier block and unchanged guidance file.
- The plugin does not create project configuration, local-rules templates, task agents, daemons, or custom agent loops.

## Requirement Contract

A project requirement belongs in a project `WATCHDOG.yml` `verifier` entry. It must name its trigger, check id, Gold condition, executable narrow check, and PASS evidence. The verifier runs the applicable command; specifying an unexecuted future check does not establish a result.

A supplied project command takes precedence over manifest lookup: its check id labels the result and does not imply that the id is installed. Coordinator `verify` is for discovered manifest ids, not a replacement for an explicitly required project command.

Requirement triggers are evaluated against newly delivered primary updates. Historical requests/results and primary-only continuation or completion reminders do not independently retrigger checks; a recurring requirement trigger or explicit recheck request does.

Automatic and manifest verification output is already structured. The coordinator's text reporter renders actual `FAIL`/`BLOCKED` results as status/check ID, summary, optional evidence, and next check. The verifier requests `--reporter text --failures-only` and relays that output unchanged in native `advise` with severity `blocker`. No paraphrase, advice, successful rows, selection metadata, or invented next check is added. JSON remains available for machines. Commands without structured output are classified against their explicit Gold condition using observed command/exit/output evidence and the same readable layout. `PASS`, `SUPPRESSED`, and no applicable results call for silence. These are prompt contracts, not runtime-enforced output admission; the native UI channel remains “Advisor.”

A deliverable result needs an actual `FAIL`/`BLOCKED` classification, check id, and concrete summary. Headings and format placeholders are not results. Malformed manifest stdout is reported as a coordinator `BLOCKED` result with bounded output evidence (or an empty-stdout diagnostic) and a next check; the raw heading is not relayed alone. Missing current-turn paths, skipped automatic invocations, and empty results are inapplicable verification, not unavailable-check prerequisites, and must not produce invented blocker rows. These distinctions remain model guidance at native advice admission.

Completed failure-only coordinator output rendered as `(no output)` is expected for `PASS`, `SUPPRESSED`, and no results. Missing rendered exit metadata alone does not make it unreadable or justify a blocker or rerun. Only an observed execution error, such as an invocation diagnostic, missing executable, or timeout, warrants synthesizing a verifier-execution `BLOCKED` result. Empty stdout from a manifest entry is different: the coordinator validates that entry and emits its own complete `BLOCKED` result.

Review completion is separate from result delivery. Once applicable check attempts finish, a review with no reportable failure ends normally with a private `Complete.` response and no `advise` call. In the verified OMP 18.11.1 runtime, ordinary advisor final text is not forwarded to the primary. Primary-agent status messages, acknowledgments, and requests to finish are not verifier results; they do not create a reason to send a note. The verifier reserves native delivery for complete blocker results rather than `nit`, `concern`, or unclassified notes. This remains a prompt contract.

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

`PASS`, `FAIL`, and `BLOCKED` are the only valid statuses. Invalid manifests, duplicate IDs, path traversal, missing entries, timeouts, non-zero exits, oversized output, malformed JSON, and missing prerequisites fail closed as `BLOCKED`; none may become `PASS`.

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

`standardId` must match the manifest ID. `source` identifies a maintained file and optional Markdown heading fragment inside the installed package. Contract and source paths are checked after realpath resolution; unsupported modes, versions, context types, missing sources, or invalid fragments are BLOCKED with the actual check ID. The provider owns policy and its Gold/rubric; the runtime does not derive semantic policy from arbitrary prose or metrics.

The protocol uses the same coordinator and named verifier advisor:

1. `automatic` or `verify` prepares a fresh request and returns `BLOCKED` with `reviewRequest`. This means assessment is pending, not that the source violated the standard. The advisor must finish supported requests before delivering a final blocker.
2. `review <request-file>` returns current captured evidence, scope, provider source, Gold, and rubric. Its JSON is pretty-printed: provider source `text` is an array of original lines, while project-record `content` maps original one-based line numbers to exact source text. Use those keys in citations rather than counting JSON entries. `review ... --context <project-relative-path>` captures targeted additional files and supersedes the earlier request ID.
3. The existing model assesses the supplied rubric using actual changed code and relevant project context. Project-local architecture takes precedence. A small meaningful invariant may pass; a trivial extraction is not justified by naming or file size alone.
4. `evaluate <request-file> --assessment -` reads an assessment from stdin. It requires the actual current `requestId`, `status` (`PASS`, `FAIL`, or `BLOCKED`), non-empty `summary` and `rationale`, and `citations` containing project-relative `path`, original one-based `line`, and exact source `quote`. PASS/FAIL require a matching citation in the changed scope; BLOCKED may explain unavailable evidence without a source citation. Supply the smallest corrective `nextCheck` for failures or blocks.
5. The runtime checks the current request, provider/standard hashes, project context, and citations, then consumes the request. Final results preserve the standard ID/source and Gold. Only final FAIL/BLOCKED results are delivered through native blocker transport; PASS stays private. Correct the source or apply an allowed bounded reasoned exception, then prepare a fresh evaluation. A planned check, consumed request, superseded assessment, or earlier PASS cannot clear a later change.

Capture includes current changed source, caller/sibling evidence, recognized project guidance including README files, and a bounded source inventory. Confirmed deletions retain their prior captured or Git source, including a previously observed untracked helper removed during correction. Missing required guidance or source prevents PASS. Retrieval limits are operational bounds, not semantic failure criteria: up to 1,200 inventory files, 8 MB of inventory reads, 40 evidence records/128 KB of evidence, and 16 KB per changed or explicitly requested file. Use targeted context where it can establish missing evidence; otherwise report BLOCKED rather than guessing.

Requests are private, atomically written, per-project operational cache, not a knowledge store or reusable PASS cache. Per-check locks serialize overlapping preparation/completion. A busy or abandoned lock is BLOCKED; it is not automatically stolen. Only remove a reported abandoned lock after confirming the owner PID recorded in it has exited.

## Completion Boundary

This integration requires evidence-backed correction through the existing advisor path; it does not implement an atomic completion gate. The plugin does not register a `session_stop` veto or bind main-session settlement to completion of the named verifier's current assessment.

OMP does expose a native [`session_stop` decision](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/session/agent-session.ts#L5148-L5184): ordinary continuation is capped, while an explicit `decision: "block"` is exempt from that cap. The missing integration is not a claim that OMP has no veto primitive. A genuine hard gate also needs reliable current-turn advisor completion/outcome and an actual stop decision that waits for that evidence. [OMP #15422](https://github.com/can1357/oh-my-pi/issues/15422) tracks the extension-observable advisor-finished/outcome handoff.

OMP 18.11.1 deliberately [captures advisor-triggered repair continuations without scheduling another review](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/session/session-advisors.ts#L573-L582) to prevent advisor→primary→advisor cascades. A fresh independently triggered run, such as an explicit scoped recheck request, is needed to schedule the next peer assessment. Waiting alone cannot turn that repair into a verified PASS. Recheck the actual corrected scope, including a newly created helper that was removed; do not substitute unrelated working-tree paths or claim alignment before the fresh result.

Native blocker delivery followed by primary correction and a fresh PASS proves the exercised correction cycle, not that every unverified primary completion is prevented. Advisor scheduling, model availability, and settlement remain OMP-owned. This release adds neither a second stop loop nor a custom model runner.

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

An entry writes one JSON object to stdout with a required `status` (`PASS`, `FAIL`, or `BLOCKED`) and non-empty `summary`; `evidence` and `nextCheck` are optional. The runner bounds output and text fields, validates the shape, and enforces the manifest timeout. Malformed output, stderr, timeout, missing entry, invalid manifest, or other unsuccessful execution cannot become `PASS`. A structured `FAIL` is retained when the result is valid and stderr is empty, including on a non-zero process exit; other non-zero exits are `BLOCKED`.

Each result has an `id`, `status`, and `summary`, plus optional `evidence` and `nextCheck`; automatic selected or suppressed results include `matches` carrying changed `path` and matched `trigger`. Completed semantic results also carry `standard` (ID/source/Gold) and `evaluation` (mode/request ID). Pending semantic results carry `reviewRequest` instead.

| Outcome | Meaning and Verifier behavior |
| --- | --- |
| `PASS` | The executable reported its Gold condition met, or a current semantic assessment was admitted against validated evidence. This is not independent proof of overall code quality. |
| `FAIL` | The declared check reported a violation. The verifier relays the text reporter's actual failing result through native `blocker` transport. |
| `BLOCKED` | The check could not establish PASS/FAIL, or discovery/execution/result validation failed. The verifier relays the text reporter's available result, without inventing evidence or remediation. |
| `SUPPRESSED` | Verifier matched a valid bounded suppression and did not run the check for that path. This is not a PASS; automatic guidance stays silent. |
| No result | No automatic check applied (or there were no changed paths). This is not a PASS; automatic guidance stays silent. |

Automatic and manual CLI execution defaults to a JSON result array; `--reporter json` is explicit, and `--reporter text` renders readable results. `--failures-only` filters execution output to FAIL/BLOCKED, producing empty text or JSON `[]` when none remain. Text omits selection metadata, preserves existing multiline structure, wraps long prose at word boundaries, and shares its formatter with slash commands. Execution exits `1` for any FAIL/BLOCKED, otherwise `0`; invalid usage exits `2`. Discovery defaults to a JSON inventory and exits `1` for discovery blocks, otherwise `0`. `review` exposes the current pending request in inspection-oriented JSON; `evaluate` uses the normal result reporters.

**Interpretation limit:** PASS from a narrow manifest check proves only that the check entry returned a valid PASS result for its declared contract. It is not a code-quality certification, an approval of unrelated behavior, or proof that generic review concerns were checked.

## Ownership Boundaries

- **OMP Verifier** owns its marked advisor setup/cleanup, commands, manifest discovery, path selection, bounded exceptions, trusted executable invocation, current semantic evidence/request validation, result reporting, and the existing model's contract-assessment guidance.
- **A policy/check-owning package** owns the standard, Gold, applicability, and executable implementation or semantic rubric. [Marlens Skills, Rules, and Tools (MSSRT)](https://github.com/klondikemarlen/marlens-skills-rules-and-tools) supplies reusable Marlen coding guidance and declared checks/contracts. Verifier does not invent policy or infer checks from prose, filenames, or tool names.
- **A project** owns explicit command requirements in project `WATCHDOG.yml`, bounded ID/path `requirements` and reasoned exceptions in `.omp-verifier.json`, and any project-specific check package. A supplied command names its trigger, Gold condition, narrow check, and PASS evidence.
- **OMP's default advisor** retains generic code quality, robustness, strategy, scope, style, and workflow review. Verifier's model runs applicable checks and returns their evidence, not general advice.
- **OMP advisor runtime and configuration** own model resolution, scheduling, and actual advisor interaction with the primary agent. Verifier does not choose or rewrite model/provider routes; live correction claims require the verifier model to resolve and an observed blocker/remediation cycle.
- **OMP Learner** (the [OMP Learner repository](https://github.com/klondikemarlen/omp-learner)) owns high-confidence feedback classification and the human-reviewed proposal route for accepted lessons. Learning an observation does not silently create or activate verifier policy.

The collaboration path is therefore: OMP Learner may surface a reviewable lesson; its intended policy owner (for reusable Marlen guidance, MSSRT) accepts and implements a rule/check; the package declares its check; Verifier selects and executes it and presents evidence; OMP's advisor runtime delivers the correction interaction.

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

## Learner Promotion Path

The [OMP Learner project](https://github.com/klondikemarlen/omp-learner) captures high-confidence style and concept feedback in OMP memory and reviewable tickets. It must not silently turn an observation into executable policy. The intended promotion path is:

```text
user correction or repeated feedback
  -> learner memory and/or reviewable ticket
  -> accepted shared rule or project rule
  -> explicit deterministic manifest or versioned agentic standards contract
  -> verifier evidence
```

Deterministic checks belong in manifests when a rule has a bounded, reproducible signal. Qualitative standards remain with their guidance owner unless accepted as an explicit agentic contract with Gold, required context, and a rubric. A Learner guidance-coverage note proves neither that such a check exists nor that current code was evaluated; accepting a missing-verification proposal does not require adding another copy of the rule.

## Related Feature Tickets

- [OMP Verifier #82](https://github.com/klondikemarlen/omp-verifier/issues/82) — consume installed plugin verification manifests.
- [MSSRT #227](https://github.com/klondikemarlen/marlens-skills-rules-and-tools/issues/227) — expose reusable Marlen-specific checks.
- [OMP Learner #99](https://github.com/klondikemarlen/omp-learner/issues/99) — promote accepted lessons into reviewable verifier-check proposals.
- [OMP Verifier #130](https://github.com/klondikemarlen/omp-verifier/issues/130) and [MSSRT #513](https://github.com/klondikemarlen/marlens-skills-rules-and-tools/issues/513) — supplied semantic standards, current evidence, and correction/re-verification.

## Release

Release ownership runs issue → issue-named branch → linked draft PR → complete self-review → focused QA and `npm run release:check` → resolved feedback and required checks → merge commit → synchronized `main` → remote reinstall → fresh-process installed behavior.

Advisor-correction claims additionally require a resolved verifier model in `/advisor status`, a packed or remotely installed failing-check scenario, observed verifier blocker delivery, primary-agent remediation, and a clean follow-up coordinator result. `PASS`, `SUPPRESSED`, and no results must remain silent; incomplete remediation must be checked across `advisor.immuneTurns`.
