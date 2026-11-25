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

`default` receives OMP's stock advisor prompt. On setup, `verifier` copies the active runtime generation's `WATCHDOG.md` to `<agent-dir>/verifier/WATCHDOG.md`, substitutes the persistent launcher path, and imports that generated file. The verifier model receives `bash` to select and execute applicable checks. Generic quality, scope, strategy, style, and workflow review remain with `default`; they are not verification results.

## Lifecycle

- Extension registration awaits guidance and roster reconciliation through OMP's active-profile SDK before native advisors import the generated file. Session starts also reconcile the active context; independent advisors remain untouched.
- When native OMP schedules a review, the verifier advisor binds transcript changes to their edit-owned Git checkouts and invokes the packaged automatic coordinator once per complete checkout group. It validates each request's root and changed scope before assessment and keeps recovery in that checkout. Unknown ownership stays BLOCKED; same-named files in another worktree do not establish identity. The plugin has no `agent_end` notification runner and does not select review cadence.
- `/verifier status` reports global and project roster entries plus the guidance-file path.
- `/verifier uninstall` removes only the marked verifier block and unchanged guidance file.
- The plugin does not create project configuration, local-rules templates, task agents, daemons, or custom agent loops.

### Runtime Generations

The persistent launcher lives at `<agent-dir>/verifier/omp-verifier.mjs`, outside package-manager replacement paths. Its private `runtime` directory contains an atomic active-generation pointer and independent artifact directories. A generation captures the coordinator, registered verification providers, supplied standards, executable entries, and installed runtime/peer/optional dependencies. Copies have independent contents, not hard links to development or installed files; package-internal symlinks remain internal. Missing required dependencies or a package changing during capture blocks preparation.

A provider can set `omp.verificationDependencies` in `package.json` to the direct dependencies needed by **all** of its checks. For example, `["typescript"]` keeps the installed TypeScript package and its entire installed runtime dependency graph. Include dependencies used by dynamic imports, subprocesses, and platform-specific branches; Verifier does not infer dependencies from source. Each name must be unique and declared in `dependencies`, `peerDependencies`, or `optionalDependencies`. Use `[]` only for checks that need no external packages. Omit the field to keep the full graph.

This declaration narrows only the provider's dependency roots. It does not remove provider files (including helpers, standards, and assets), change which checks are registered, or narrow a package needed transitively by another check. Existing generations are not rewritten.

`/verifier generation prepare` snapshots the installed artifacts without activating them. Preparation and activation validate the content digest, coordinator catalog, semantic contracts, and deterministic-entry syntax. These checks do not replace release tests or prove semantic PASS. `activate <generation-id>` changes the pointer only after validation. `status` exposes generation ID, digest, provider versions, and source installation paths. `npm run reinstall` preserves the existing runtime during uninstall/install, then prepares and activates the remote replacement. A failed install or candidate validation does not replace the active pointer. After an independent provider update, explicitly prepare and activate a generation to adopt it.

Each invocation leases one generation. Later `review`, `evaluate`, and `diagnostics` calls select the original generation encoded in the private request path. Review caches are generation-specific: neither pending state nor accepted results are silently reused by a new generation. Results identify their artifact generation; an old-generation PASS is not proof from its replacement. Project source and captured evidence still undergo the ordinary freshness checks. New invocations through the same persistent launcher adopt the active generation without restarting an already bootstrapped OMP session.

Explicit `generation collect` removes inactive, previously activated generations with no execution leases and no pending semantic states. Normal commands retain completed generations so accepted results can still be read and freshness-checked after assessment. Collection makes those old executable artifacts unavailable; retained review records are not a substitute for executable freshness validation. Prepared candidates remain available for activation. Abandoned execution leases retain artifacts because their child processes may survive; inspect the recorded process and its children before manually removing an abandoned lease. Never remove a pending review's generation merely to reclaim space.

Linux `flock` supplies process-lifetime locking, including kernel release after interruption; no daemon or model runtime is added. Provider dependency closure consumes disk space per retained generation. Installs predating generation isolation may still have live package paths embedded in existing sessions and saved requests. They are not retroactively pinned: finish those reviews with their original coordinator before replacement, or prepare a fresh complete review after adopting this release. Native extension hot reload remains separate; this mechanism changes no models, credentials, advisor cadence, or unrelated sessions.

### Delivery Handoff

Cleanup may remove an edit-owning checkout before native final-yield review starts. The source-lifetime handoff binds a clean committed delivery to its original repository, immutable base/tip, and complete changed paths (including deletions). It does not schedule a reviewer, certify a merge or waiver, transfer semantic requests, or copy dependencies.

```text
omp-verifier handoff prepare --base <actual-delivery-base>
omp-verifier handoff recover <handoff-file>
omp-verifier handoff check <handoff-file> [--reporter text] [--failures-only]
omp-verifier handoff release <handoff-file>
omp-verifier handoff cancel <handoff-file> --reason <explicit-user-reason>
```

The primary receives cleanup guidance through `before_agent_start`. Run `prepare` in the clean delivery checkout before removing it, using the actual ancestor base, and preserve the returned `handoffPath` and identity in the transcript. Preparation rejects uncommitted/untracked source; ignored dependencies are not retained. Keep the original checkout if preparation fails.

Preparation pins the delivered tip under a unique Git ref and writes a private handoff record. On initial recovery, the recorded original must be clean, canonical and at the delivered tip. Its ignored environment stays in place. A dirty, moved or foreign original blocks selection; only an absent original permits detached recovery. Once selected, a surviving owned detached checkout remains the review source even if the original path reappears. Recovery validates repository identity, pinned commits, checkout and full changed-path scope.

Run `handoff check <handoff-file>` from a surviving directory. The coordinator selects the recorded checkout, base and full set of changed paths; caller-supplied paths and verdicts are not accepted. The first check starts a fresh verification. If it returns `PENDING`, complete the assessments in the selected checkout, then run the bound check again. A background job ID means the invocation has not returned: await its result rather than trying to release the source. Missing tools, services or ignored dependencies remain real blockers; the handoff never provisions them.

The reviewer releases its handoff after all applicable assessments finish, before private completion or blocker delivery. Recoverable context is not completion. `release` removes only the owned clean detached verification checkout, when present, and pin; it never removes the original checkout or its ignored environment. Dirty recovered evidence is preserved for investigation. The small receipt remains. Active handoffs have no automatic expiry, so interrupted reviews retain recoverable source until resumed or explicitly cancelled. Only an explicit user waiver/cancellation permits `cancel`; its reason is recorded and neither it nor a merge is a PASS. Released/cancelled records cannot be recovered, and completion-only updates do not reopen finished review.

`check` returns verification results, not a lifecycle receipt. A completed check with no applicable results has nothing to assess. The other successful operations return non-verdict statuses `PREPARED`, `RECOVERED`, `RELEASED`, or `CANCELLED` and exit 0. Invalid syntax exits 2. A source or ownership prerequisite produces `BLOCKED verifier:delivery-handoff` and exit 1. Real check FAIL/BLOCKED remains reportable even if disposal also fails.

### Resource Closeout

`verifier:resource-closeout` verifies an explicitly declared final inventory independently of source review. The primary owns resource creation, cleanup authority, project wrappers, and retention decisions. Verifier only observes; it cannot authorize deletion, run cleanup commands, prove an omitted resource absent, or enforce native host settlement.

Use this procedure when resource verification is explicitly requested. Routine post-merge cleanup uses the project's safety checks without preparing a Verifier inventory. The inventory limit measures resources considered for disposal, not the number of changed paths in the PR.

Prepare the baseline **after testing, immediately before destructive cleanup**: run `omp-verifier closeout prepare <declaration.json>` from the surviving repository. If cleanup could disrupt a protected consumer that is still active, retain the affected resources rather than stopping the consumer to clear the check.

The declaration contains `version: 1`, a nonempty `taskId`, absolute normalized `repositoryRoot`, concrete `authorization` evidence, and between 1 and 64 exact `resources`. Every resource has unique `id`, `kind`, `disposition` (`absent` or `retained`), `ownership` (`task`, `protected`, or `unknown`), `ownershipEvidence`, and a concrete `reason`. Only task-owned resources may request absence. Declare protected or uncertain resources as retained, including shared resources whose preservation matters to this cleanup.

Kind-specific fields:

| Kind | Required identity |
| --- | --- |
| `path` | Absolute normalized `path`; contents are hashed, never copied into results. |
| `git-worktree` | Absolute `path`; both exact Git registration and filesystem presence are checked. |
| `git-ref` | Exact fully qualified local `ref`. |
| `git-remote-ref` | Configured `remote` name and exact fully qualified `ref`. |
| `docker-container`, `docker-volume`, `docker-network`, `docker-image` | Exact `name` (tag for images), Compose `project`, and absolute project `wrapper` path. |

A present Git resource declared absent also requires `delivery`: full `baseCommit`, `tipCommit`, `deliveredCommit`, configured `remote`, and exact remote `targetRef`. The declared tip must match the actual resource. Fresh remote evidence must contain the delivered commit. Ordinary merge ancestry proves delivery; rewritten delivery additionally needs `deliveredBaseCommit` and complete changed-path/tree equivalence. Required objects must already be available locally; Verifier never fetches or prunes. Uncommitted tracked work blocks preparation; untracked/ignored worktree contents require explicit `disposableContents: true`. This is evidence capture, not permission to delete the worktree.

For a delivered dependency-heavy checkout, set `"largeWorktree": true` **on that exact `git-worktree` resource**, alongside `"disposition": "absent"`, `"ownership": "task"`, `"disposableContents": true` and the ordinary delivery proof. Verifier fingerprints all tracked, untracked and ignored files; the receipt records counts instead of enumerating thousands of names. The opt-in allows 16,384 distinct Git paths per checkout and 512 MiB per file. A separate completeness scan visits at most 16,384 subdirectories and rejects entries Git cannot inventory. All opted-in worktrees in one observation pass share 1 GiB of content and 120 seconds; use separate declarations for independently owned deliveries that exceed the combined budget. Incomplete observation still blocks cleanup. Leave the field out for ordinary resources.

For example, a temporary ignored file outside the surviving checkout:

```json
{
  "version": 1,
  "taskId": "issue-123",
  "repositoryRoot": "/work/project",
  "authorization": "Maintainer authorized removal of this task's disposable QA environment",
  "resources": [
    {
      "id": "qa-environment",
      "kind": "path",
      "path": "/work/project-worktrees/issue-123/.env",
      "disposition": "absent",
      "ownership": "task",
      "ownershipEvidence": "Created for this task's isolated QA only",
      "reason": "QA completed; no pending consumer needs this file"
    }
  ]
}
```

Preparation validates the repository and baseline observations, captures Docker wrapper hashes, and returns `PREPARED` with a private `receiptPath`. It is not PASS. Keep that exact receipt; do not edit it. Input and receipt size is limited to 256,000 bytes. Receipt permissions must remain owner-only. Evidence hashes detect accidental changes, not a malicious same-user process that can rewrite the receipt.

By default, each `path` inventory allows 4,096 entries and 64 MiB of file content. Declare the narrowest resource whose disposition matters; routine source review does not require hashing an installed toolchain. If a large artifact **is itself** the resource—for example, a frozen runtime that must remain unchanged—set `"largeArtifact": true` on that exact `kind: "path"` resource. Omit the field otherwise. In each preparation or verification pass, all marked paths share 1 GiB of content reads and 60 seconds of observation time. Each path still has the 4,096-entry limit. Verifier hashes the full contents; an unsupported setting, incomplete read, or exhausted budget yields BLOCKED, not partial approval. The opt-in does not authorize removal.

After primary-owned cleanup through the documented project wrapper, run `omp-verifier closeout verify <receiptPath>`. Each call freshly observes resources and compares authority with the baseline. Retained resources must preserve identity and captured content/configuration; absence is classified as `removed` or `already absent`. Successful retention is `intentionally retained`. Existing disposable resources and damaged preservation are FAIL; unavailable prerequisites or changed repository/remote/Docker authority are BLOCKED. A known failure remains FAIL when another resource is blocked; per-resource evidence preserves both. JSON includes capture/observation timestamps and dispositions. Text supports the ordinary failure-only reporter; successful checks remain silent with `--failures-only`.

A retention failure says **what changed, not what caused it**. For example, if Docker recorded the captured container ID exiting before the first cleanup command, report that ordering. It does not tell you who stopped the container or why. Preserve the failed receipt and compare the exact identity, event times, and cleanup commands. If the identity is gone, report the exception as FAIL, including anything still unknown. Do not recreate its name, omit it from a replacement receipt, or repeat the same check hoping for PASS. Address separately any resources that can still be cleaned up safely.

Docker discovery distinguishes a successful exact absence from daemon/permission/inspection failures. Compose labels establish identity, not disposability. The check captures daemon/context identity, stable configuration hashes, and bounded container mount evidence without exposing environment values. The wrapper must exist at preparation but need not survive cleanup; Verifier never invokes it. Use a real isolated Compose project and its wrapper for release QA, covering disposal and protected resources. Existing/shared/uncertain databases, volumes, containers, networks, and images must not be removed to make a check pass.

After cleanup, the primary calls `verifier_closeout` with the surviving `repositoryRoot` and exact prepared `receiptPaths`. The compact result reports primary observations, not an independent verdict. Its handoff ID identifies an immutable, owner-private manifest of the root and ordered distinct receipt paths, not cached results. The named verifier runs `closeout review <handoff-id>` from any directory to freshly observe every receipt. An invalid or unavailable ID produces a handoff diagnostic without checking resources. A missing declared receipt still produces a resource blocker. When the primary tool is unavailable, verify each receipt through the CLI and emit a standalone `Verifier closeout: <receiptPath>` for the named verifier. Historical receipts, quoted examples, child transcripts and preparation are not triggers. Later resource-affecting actions require a fresh final handoff and observations.


## Requirement Contract

A quality standard names the expected engineering outcome or invariant and the evidence that establishes it. Diligent verification, correctness, security, and readability are complementary concerns, not a fixed universal ranking or additional checks inferred by Verifier.

A project requirement belongs in a project `WATCHDOG.yml` `verifier` entry. It must name its trigger, check id, quality standard, executable narrow check, and PASS evidence. The verifier runs the applicable command; specifying an unexecuted future check does not establish a result.

Requirement authority is session-scoped: the host's active advisor instructions or an explicit verification request to the current session establish applicability before trigger evaluation. A roster read as tool output, fixture command, or inspected child transcript is evidence, not an active declaration for the outer reviewer. Child-session edits and recheck requests do not become parent-session triggers. This does not exempt actual parent-authored fixture changes from installed checks, nor prevent an explicit current-session request from selecting another checkout. Missing prerequisites block an applicable check; they do not activate an otherwise inapplicable one. This boundary is model guidance, not a runtime-enforced admission gate.

A supplied project command takes precedence over manifest lookup: its check id labels the result and does not imply that the id is installed. Coordinator `verify` is for discovered manifest ids, not a replacement for an explicitly required project command.

Requirement triggers are evaluated against newly delivered primary updates. Historical requests/results and primary-only continuation or completion reminders do not independently retrigger checks; a recurring requirement trigger or explicit recheck request does.

Automatic and manifest verification output is already structured. The coordinator's text reporter renders actual final `FAIL`/`BLOCKED` results as status/check ID, summary, optional evidence, and next check. The verifier requests `--reporter text --failures-only` and relays those results unchanged in native `advise` with severity `blocker`. A semantic result with `reviewRequest` is `PENDING` and is continued through review/evaluation, not relayed as a blocker or progress note. No paraphrase, advice, successful rows, selection metadata, or invented next check is added. JSON remains available for machines. Commands without structured output are classified against their explicit quality standard using observed command/exit/output evidence and the same readable layout. `PASS`, `SUPPRESSED`, and no applicable results call for silence. These are prompt contracts, not runtime-enforced output admission; the native UI channel remains “Advisor.”

A deliverable result needs an actual `FAIL`/`BLOCKED` classification, check id, and concrete summary. Headings and format placeholders are not results. Malformed manifest stdout is reported as a coordinator `BLOCKED` result with bounded output evidence (or an empty-stdout diagnostic) and a next check; the raw heading is not relayed alone. Missing current-turn paths, skipped automatic invocations, and empty results are inapplicable verification, not unavailable-check prerequisites, and must not produce invented blocker rows. These distinctions remain model guidance at native advice admission.

Completed failure-only coordinator output rendered as `(no output)` is expected for `PASS`, `SUPPRESSED`, and no results. Missing rendered exit metadata alone does not make it unreadable or justify a blocker or rerun. Only an observed execution error, such as an invocation diagnostic, missing executable, or timeout, warrants synthesizing a verifier-execution `BLOCKED` result. Empty stdout from a manifest entry is different: the coordinator validates that entry and emits its own complete `BLOCKED` result.

Review completion is separate from result delivery. A review with no reportable failure ends normally with a private `Complete.` response and no `advise` call only after all applicable requests reach accepted final results. Unread pages or supported context recovery are not complete. A concrete unavailable execution prerequisite instead permits an honest execution BLOCKED handoff; an unconsumed request remains unapproved, not a source verdict or PASS. In the verified OMP 18.11.1 runtime, ordinary advisor final text is not forwarded to the primary. Primary-agent status messages, acknowledgments, and requests to finish are not verifier results; they do not create a reason to send a note. The verifier reserves native delivery for complete blocker results rather than `nit`, `concern`, or unclassified notes. Native blocker delivery is not a completion veto. This remains a prompt contract.

### Advisor Silence: Plugin Policy and QA

The silence/blocker-only policy belongs to this plugin. OMP's ability to deliver a native advisor note does not establish that the note satisfies Verifier's result-only contract. Prompt guidance is not a hard admission gate, and observed behavior for one model and runtime does not establish model-independent enforcement.

The [README's advisor-correction procedure](../../README.md#development-and-release) owns live release QA. Historical findings and version-specific results remain in their issue and PR records, including [Verifier #117](https://github.com/klondikemarlen/omp-verifier/issues/117), [the attribution correction in #119](https://github.com/klondikemarlen/omp-verifier/issues/119), and [PR #122's native QA evidence](https://github.com/klondikemarlen/omp-verifier/pull/122#issuecomment-6151394004); they do not establish a current verdict.

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

`PASS`, `FAIL`, and `BLOCKED` are final verdicts. A deterministic entry may return `N/A` with a non-empty summary and exit `0` to identify inapplicable work; the coordinator removes it from both manual and automatic result arrays rather than treating it as approval. Nonzero `N/A` exits remain execution `BLOCKED`. Valid structured `FAIL` and `BLOCKED` results survive nonzero exits when stderr is empty. Invalid manifests, duplicate IDs, path traversal, missing entries, timeouts, other non-zero exits, oversized output, malformed JSON, and missing prerequisites fail closed as `BLOCKED`; none may become `PASS`. This deterministic non-verdict does not extend the semantic assessment status vocabulary.

“All checks” means all valid checks explicitly declared by installed plugin manifests. It does not mean scanning remote repositories, guessing from tool names, or running package-maintainer `scripts/verify-*.mjs` files. Verification entries are trusted installed code, not a sandbox; the verifier accepts no model-supplied command or executable path.

The public commands are:

```text
/verifier checks
/verifier verify
/verifier verify <check-id...>
```

Verifier itself declares the project-lint manifest. An isolated package directory without compatible manifests reports `none installed` from `checks` and `BLOCKED` from `verify`; installed checks with no applicable work produce an empty result array. Existing `/verifier`, `/verifier status`, `/verifier uninstall`, advisor setup, and guidance ownership remain independent.

The packaged CLI also exposes `checks` and `verify [<check-id>...]` to the `bash`-only advisor. By default, `checks` returns a JSON object with public check metadata (`id`, `label`, `description`, optional `pathTriggers`) and `blockedResults`; it does not execute entries. `verify` returns the existing result array, shares manual execution with `/verifier verify`, and runs only exact requested IDs when supplied. Both commands also support `--reporter text`. The model selects named checks only for explicit applicable requirements, not as a catch-all review substitute.

## Request Intent and Proof Reuse

Verifier owns a small request contract on OMP's supported `before_agent_start` hook. The host supplies the dequeued, transformed prompt and session identity; the plugin parses only its exact first line: `Verifier work level: quick tweak`, `Verifier work level: normal`, or `Verifier work level: rearchitecture`. No declaration means normal. An invalid or ambiguous declaration cannot grant quick eligibility. A new prompt replaces the prior session request; revival is not a new user declaration. This is plugin-owned state, not a native work-level setting or a model/router change.

The visible `verifier-work-intent` message carries a compact opaque handle and level. The advisor passes that handle to `automatic --request <handle>` with the ordinary changed paths and actual PR base. The coordinator validates the private request record and its current-session pointer; stale or altered handles produce BLOCKED rather than skipping checks. Without a handle, automatic verification retains its previous full-selection behavior. This protects accidental replay and cross-request stickiness, not malicious processes running as the same OS user.

Quick intent omits optional manifest path triggers but preserves applicable `.omp-verifier.json` requirements, including missing-provider diagnostics and existing explicit bounded suppressions. Explicit project commands and manual `verify` are unchanged. Safety eligibility remains advisor judgment over the actual request and edit: a local binding rename may qualify, while serialized/public fields, authorization, initialization order, persistence, concurrency, and control-flow changes do not. `automatic --request <handle> --full` selects all applicable checks without proof reuse for escalation, explicit rechecks, full initial-delivery review, and release gates. The prefix cannot authorize merge, publication, or omission of mandatory checks.

For normal intent, automatic semantic preparation can return the exact previously accepted PASS, FAIL, or BLOCKED, or preserve an equivalent PENDING request with its actual page receipts, only when the selected check/provider, owning checkout, complete changed-path scope, delivery identity, capture policy, and all captured source/guidance/context evidence remain current. Previously recovered caller and external context remain part of that validation. Invalid or missing prior proof prepares fresh PENDING work under the existing complete-review protocol. Reuse preserves request identity without treating delivered pages as assessment, and does not clear another check's failures. Repeated deterministic checks are not cached; rearchitecture and manual/explicit full checks do not reuse semantic results. No subset result approves a larger scope.

OMP 18.19.0 exposes the hook but truncates generic custom-message content in advisor history. The handle and normalized level therefore occupy the compact beginning of a displayed message; hidden custom messages are not suitable transport. Supported-hook availability, current handle visibility, selection, and native safety escalation must be exercised in a fresh process. This feature does not fix native completion gating, literal result transport, or within-review context exhaustion.

### Interrupted Verification

Rerun `verify`, `automatic`, `lint`, or `handoff check` with the same scope in the same working directory. No job ID or resume flag is needed. A private journal retains completed executable PASS results and supported project/language lint groups from an unfinished run. A command interrupted before returning runs again from its beginning. Failures and blockers are checked again, not converted to successes. Resource closeout always makes fresh observations.

A saved semantic request ID is a pointer, not a verdict. The semantic coordinator validates the current request and evidence before restoring it. Continue with `review --resume` in the owning checkout. Completing the coordinator run retires its restart journal, even if a named reviewer still owes an assessment. An explicit full check after a completed run stays fresh.

Changed Git-visible source, delivery base, selected scope, runtime or options invalidate saved work. An overlapping invocation does not read or overwrite the active invocation's journal. If proof is unavailable, Verifier runs the checks normally. Use `--fresh` when inputs outside that identity change, such as an external service or ignored dependencies. Timing history is never used as proof.

### Run Timings

`/verifier timings` and `omp-verifier timings [--reporter text|json]` show recent `verify`, `automatic`, `lint`, and `handoff check` runs, newest first, for the invocation's working directory. Read history from the same directory, even when a handoff selected a different checkout. Compare like runs and check IDs: different inputs, generations or outcomes can explain a timing change. A slow sample or a change from PASS to FAIL is not itself proof of flakiness.

`automatic --progress` writes observed check transitions to stderr, including when Bash captures output without a PTY. Without the flag, progress is enabled only if stdout and stderr are both terminals. Elapsed times are measured at transitions, not updated by a heartbeat. Progress never changes reporter stdout or exit status.

During an interactive advisor Bash call, the editor widget reads the existing timing snapshots for that automatic invocation. An opaque correlation key distinguishes overlapping calls; the widget does not display the command, transcript, diagnostics, or source. It reports observations, not verdicts. A missing display does not stop verification, and a returned check does not establish completion of a pending semantic review.

Use the run ID to distinguish overlapping invocations in the same checkout. Each executed check records `startedAt` and, where enforced, `timeoutMs`. `STARTED` means its start was observed but its return was not. Time since that observation is not proof that the child is alive, stalled, or past an enforced deadline. Wait for the original invocation if you have its live job handle; without terminal output or a confirmed job, the outcome is unknown. An observed executable timeout is `BLOCKED` with `timedOut: true`. Semantic `PENDING` means preparation returned: use the review request and its diagnostics to resume, not a process timeout.

For standalone `lint`, `timedOut: true` means at least one lint group exhausted the shared budget. Another group's observed violation still makes the aggregate verdict `FAIL`. A lint group reaching its internal deadline does not mean its enclosing executable timed out.

`coordinatorMs` measures elapsed verification work, including discovery and selection, from the command handler to its results. It excludes launcher startup, rendering, and later advisor work. A check's `durationMs` covers its actual invocation, including semantic preparation or proof lookup; checks run in parallel during manual verification, so do not sum these numbers. A selection-only diagnostic has no measured check time. A missing coordinator finish can mean the process is still running, was interrupted, or could not save its final observation.

When the coordinator observes `SIGINT` or `SIGTERM` during verification, timing history reports `cancellationSignal` and `cancelledAfterMs`. This is elapsed time until interruption, not time to a verdict. Compare cancellation counts alongside completion times: dropping slow, cancelled attempts can make a check look faster than it is. A process killed without an observable signal handler (for example, by `SIGKILL`) leaves an unknown finish, not a confirmed cancellation.

`fullRunMs` is the elapsed interval through the coordinator finish and the last observed accepted assessment for its exact pending request IDs, whichever is later. A later verdict adds `finalStatus` without overwriting the original `PENDING`. An unresolved, renewed, or no-longer-retained request without matching completion evidence leaves the interval unknown. This clock can include waiting between commands; it does not measure model inference, UI activity, or native advisor settlement. Use [review diagnostics](#review-diagnostics) to inspect a single pending request.

Timing history is best-effort and owner-local under the agent directory. If that directory is inside a Git checkout, Verifier skips timing writes so they cannot change the source being reviewed. The default report shows 10 runs; `timings --limit 50` shows up to 50 from the current directory. Across all directories Verifier retains at most 500 runs and 500 semantic completion markers. History contains no source paths, finding text, command arguments, or output. Reading it does not evaluate a request or change any verdict.

### Review Diagnostics

Use `omp-verifier diagnostics <request-file> [--reporter json|text]` or the read-only `readSemanticDiagnostics({ cwd, requestPath })` export from `omp-plugin/semantic-evaluations.js` to inspect the current request for that check. The command reports requested/current IDs, whether the supplied handle was superseded, selected path/selector counts, selection and renewal reasons, current phase, payload bytes, page count, unique/repeated deliveries, next unread page, batch progress, and cached terminal status. It never exports source, file paths, prompts, credentials, assessment quotes, or command output. Invalid or unavailable CLI diagnostics return a source-free `BLOCKED` diagnostic.

Diagnostics observe saved state; they do not reconcile delivery scope, validate source freshness, acknowledge a page, renew a request, or authorize completion. `freshness: "not-checked"` applies even to a cached PASS. Continue through `review` and `evaluate` for authoritative freshness and assessment. A poll during an operation can show the last saved progress, not the operation's eventual result; this is not a live busy indicator or advisor-completion event.

`nextAction` describes the reviewer's obligation, not a running job: `resume-review`, `recover-context`, or `evaluate`. A current terminal request has no next action (`null`). Never submit a draft against a superseded handle.

To continue an interrupted review, run `omp-verifier review <request-file> --resume --reporter text` in its owning checkout. It returns one page: the first not yet delivered for the current evidence and batch, or the last page with assessment instructions if all were delivered. Delivery is not proof that the present reviewer read a page; revisit earlier pages if needed. If the PR now targets a different parent, verify against its actual base instead of carrying the predecessor's receipts forward. Neither diagnostics nor watching files drives a review.

`wallAgeMs` measures the current request's capture-start-to-observation interval, frozen at an accepted terminal result. `coordinatorMs` sums measured successful locked operation bodies, including capture and validation; `captureMs` is the capture portion, not an additional duration to sum. `unclassifiedMs` is the remaining elapsed interval. It includes uninstrumented work, lock waits, inter-call gaps, rendering, and scheduling; it is not a measurement of model inference. Counts/timings start anew on renewal. Older requests may have unavailable timing fields. Timing instrumentation does not change evidence page fingerprints.

The selection reason distinguishes default-normal intent, an explicit work level, manual automatic selection, and required full-delivery review. A mechanically small edit without an exact supported first-line declaration remains normal; no classifier is inferred from the edit. Selection reason describes request creation, not a later caller reusing it. A changed context selection records `context-enrichment` and discards old receipts even after all prior pages were delivered. A successful reuse retains identity and coverage instead. Changed scope/provider/policy preparation names that combined invalidation class without claiming which individual input caused it.

The coordinator exposes these observations, but native OMP/UI integration must consume them to replace an old activity label or show review completion. Verifier does not change that host surface, advisor cadence, or model configuration.

## Project Lint Catalog

`verifier:project-lint` separates discovery from execution. Its maintained catalog targets five language families evidenced in the maintainer's projects, not every available linter:

| Family | Supported tools | Existing project signals |
| --- | --- | --- |
| JavaScript/TypeScript | ESLint, Oxlint | ESLint configuration or `package.json` `eslintConfig`; `.oxlintrc.json` or `oxlint.config.ts`; existing simple lint scripts |
| Ruby | RuboCop | `.rubocop.yml` or a Gemfile declaring RuboCop |
| Go | golangci-lint | `.golangci.yml` or `.golangci.yaml`, owned by the Go module/project |
| Python | Ruff, Pyflakes | Ruff configuration (`ruff.toml`, `.ruff.toml`, or a `pyproject.toml` Ruff section); an explicit Pyflakes binding or simple `pyflakes`/`pyflakes3` package script |
| Shell | ShellCheck | Shell source plus an installed ShellCheck; optional `.shellcheckrc` |

Automatic calls without a base use explicit changed paths, including new untracked source. For PR verification, `automatic --base <actual-PR-base> [<current-edited-path>...]` selects complete committed merge-base-to-HEAD changes plus supplied candidates with current net changes against that base. Unchanged restored candidates and removed temporary additions are excluded, without selecting unrelated dirty/untracked paths or guessing a target branch. Resolve the actual parent for a stacked PR. The base and HEAD are resolved to commit identities before comparison; an unavailable base, unrelated history, or bounded diff failure is BLOCKED rather than a partial check. Renames select the old deletion and new destination; lint only executes existing supported sources, so deleted-only and empty applicable scope invoke no linter and never fall back to a full-project command. Named manual verification retains current Git working-tree selection; a clean worktree is not approval of committed history. `--base` is specific to `automatic` and cannot combine with `--worktree`. Source/config changes stay in their owning checkout and nested project; configuration edits select that project's current source. An ignored ESLint path is inapplicable, and empty effective ESLint rules cannot establish PASS.

Discovery prefers project-installed tools and environments, then existing PATH tools. Availability alone does not select an alternate linter. An explicit binding selects its declared supported tool before script/configuration discovery; otherwise a supported package script selects the tool and retains its existing source scope and warning policy. Conflicting tools in package scripts, or multiple tool configurations without a script selection, remain BLOCKED rather than silently dropping checks. Package execution honors `packageManager`, then existing pnpm, Yarn, Bun, or npm lockfile conventions. Native execution uses non-fixing tool modes; Ruby projects with a Gemfile use Bundler. Vue requires the selected linter's existing project support; CSS/style linting and unlisted tools remain outside the catalog.

Recognized Ruff package scripts must explicitly use `check --no-fix`; golangci-lint scripts must use `run --fix=false`. A missing fixing flag alone is insufficient because project configuration can enable mutation. Oxlint fixing, initialization, and metadata-only modes cannot establish lint verification. Unsupported scripts remain BLOCKED: an explicit binding can describe a real supported tool behind an existing wrapper, but cannot make an unsupported linter supported or relabel it as ESLint. A separate declared project check supplies its own evidence without clearing an applicable built-in catalog blocker.

If a project has a `bin/dev` or `dev` wrapper, Verifier does not guess its arguments or bypass it with a host command. The project may declare the existing trusted command in `.omp-verifier.json`, for example:

```json
{
  "lint": {
    "commands": {
      "javascript": {
        "tool": "eslint",
        "command": ["./bin/dev", "lint"]
      }
    }
  }
}
```

Bindings are argv arrays owned by the repository; they execute from the declaring configuration's directory. They attest which supported linter the wrapper runs and must preserve its non-fixing scope, rules, warning policy, and exit-code contract. Verifier cannot inspect tooling inside an opaque container wrapper; its invocation result establishes availability. Command strings, shell evaluation, installer/download commands, and fixing flags are unsupported. Unknown wrapper or complex/quoted script syntax requires an explicit existing command binding rather than automatic configuration changes.

Pyflakes needs explicit selection because it has no project configuration file. For an existing Python environment, declare `lint.commands.python` as `{ "tool": "pyflakes", "command": ["python3", "-m", "pyflakes"], "appendPaths": true }`. A project using Debian's `pyflakes3` executable or an existing container wrapper declares that actual argv instead. Verifier neither installs Pyflakes nor creates a wrapper. Oxlint projects may keep a simple script such as `"lint": "oxlint --deny-warnings ."`; it executes through the project's package manager without replacing Oxlint, changing warning policy, or narrowing the full-project command.

### Selected Paths Through Existing Bindings

Opt a trusted binding into path forwarding with `appendPaths: true`. For example, an API package's `.omp-verifier.json` can declare:

```json
{
  "lint": {
    "commands": {
      "javascript": {
        "tool": "eslint",
        "command": ["../bin/dev", "lint", "api", "--"],
        "appendPaths": true
      }
    }
  }
}
```

Each selected existing source is appended as one argv entry relative to the declaring configuration's directory, which is also the command's cwd. Thus repository path `api/src/selected file.ts` reaches that API binding as the single argument `src/selected file.ts`. An inherited root binding instead receives `api/src/selected file.ts` from the repository root. Option-looking relative filenames receive a `./` prefix. Paths outside the owning checkout are rejected before invocation. Verifier does not insert a delimiter into opaque wrapper syntax: the trailing `--` above is a project-declared argument, and the wrapper must support it.

The wrapper must preserve non-fixing rules and warnings and run only the supplied sources; appending filenames to `eslint .` does not narrow scope. Missing prerequisites remain BLOCKED and selected-file violations remain FAIL. Configuration edits still expand to current owning-project sources, and an empty/deleted-only selection invokes nothing. Omitted or false `appendPaths` preserves the existing fixed argv; other values are invalid. Existing full-project bindings, npm execution wrappers, and the project's explicit full-scope lint command remain available for deliberately broader checks. `appendPaths` does not alter `lint.executionWrapper` scripts or provision runtime tools.

### Composing npm Scripts with an Execution Wrapper

When the repository wrapper can execute a supplied command, declare `lint.executionWrapper` in the owning package's `.omp-verifier.json` instead of repeating npm's lint invocation in a language binding. For example, `api/.omp-verifier.json` can contain:

```json
{
  "lint": {
    "executionWrapper": ["../bin/dev", "exec", "api"]
  }
}
```

For a supported ESLint `lint` script, Verifier invokes `../bin/dev exec api npm run lint -- --no-fix` with cwd `api/`. The wrapper receives each prefix argument followed by `npm`, `run`, the discovered `lint` or `lint:*` script name, and ESLint's `--`, `--no-fix` arguments as separate argv entries, never shell text. The executable is resolved relative to the owning package; remaining relative arguments and the script's paths use that same working directory. A web package declares its own prefix, such as `["../bin/dev", "exec", "web"]`, and runs from `web/`. Declarations are not inherited from an ancestor package.

The project must supply that command-execution entrypoint; `exec` and service names above are examples, not discovered Docker syntax. The wrapper owns container routing, working-directory mapping, and existing non-fixing execution; Verifier neither starts application dependencies nor requires host npm, host ESLint, or container configuration inspection. The discovered script must directly invoke the catalog's supported tool without fixing flags or shell composition. The existing stricter Ruff/golangci-lint script requirements still apply. This composition currently supports npm only; other package managers remain BLOCKED rather than silently switching runtimes.

Fixed `lint.commands.<family>` bindings retain precedence and their original argv meaning. Execution wrappers preserve the package script's existing source scope, rules, warning policy, and exit codes; they do not append selected paths or turn `eslint .` into changed-file lint. Editing the declaration selects the owning project's current source. The declaration is a repository attestation that the delegated environment retains meaningful lint configuration and does not fix files, including npm lifecycle scripts. Missing wrappers or delegated prerequisites remain BLOCKED, evidenced lint violations remain FAIL, and exit 0 is PASS. Projects needing a fixed `bin/dev lint` entrypoint rather than command execution can keep the binding above.

For explicit ESLint bindings and execution wrappers, exit 1 alone does not prove that ESLint ran. Verifier recognizes default stylish diagnostic rows (including color) and complete JSON or JSON-with-metadata reports containing findings. Pyflakes findings require its file/line/column diagnostic format. Oxlint findings support default, agent/line, stylish, and complete JSON reports; the tool's own warning policy determines whether findings cause failure. For these tools, an unrecognized nonzero result remains `BLOCKED`, retaining the command and bounded original output so the owner can restore prerequisites. Custom formatters, redirected diagnostics, or JSON mixed with wrapper prose may remain unverified. Other directly discovered tools retain their native exit-code contract. No failure is converted to PASS.

Missing or unsupported tooling/configuration and invocation prerequisites are `BLOCKED`; known lint-violation exits are `FAIL`; executed applicable success is `PASS`. Combined evidence retains each language/project outcome: any FAIL wins, otherwise a BLOCKED prerequisite wins, otherwise applicable commands pass. No applicable work returns the deterministic `N/A` non-verdict and therefore no selected result. Diagnostic output is bounded, retaining all group status headings and marking shortened detail. Discovery never installs tools, creates configuration, starts services, or changes model routing. Extend the small catalog when a concrete project requires another tool, not by assuming unsupported tooling is absent.

### Recovering Slow Whole-Project Lint

By default, automatic project lint shares 100 seconds across discovery and sequential project commands, with a 120-second outer timeout. Increasing the calling shell's timeout alone does not extend that internal budget.

When the budget expires, use the summary to distinguish commands that finished from one interrupted in flight and any that never started. A changed package manifest can select whole-project lint even when no source file changed. A timeout leaves that work unverified; it neither proves a violation nor clears findings from a completed group.

For a known slow project, supply the budget on the full verification itself:

```sh
omp-verifier automatic --request "$current_handle" --full --base "$pr_base" --lint-budget-ms 600000
```

The budget is a whole number from 1 through 600000 milliseconds. It applies once, across all selected lint groups, with another 20 seconds for the lint subprocess to start and return its result. Allow enough time for the other selected checks too. This neither forces lint to run nor skips any checks: selection, suppression, project wrappers, other check deadlines, and combined reporting are unchanged. The run executes applicable lint on the current source rather than reusing an earlier result.

To retry lint alone, run the packaged CLI in the same owning checkout with the complete original lint-selected path list:

```sh
omp-verifier lint --budget-ms 300000 api/src/changed.ts web/src/changed.vue --reporter text
```

Replace the example paths with every path selected for the original lint check, including relevant configuration edits. The budget is an integer from 1 through 600000 milliseconds, shared by the entire recovery invocation. Both the budget and explicit paths are required. Give the calling shell enough time to allow the requested budget plus discovery/startup overhead. This standalone command avoids the manifest's outer timeout without changing automatic verification, persistent configuration, or `/verifier verify`.

Recovery reuses existing discovery, fixed argv bindings, and npm execution wrappers. It does not bypass `bin/dev`, provision tools, change rules/warnings, append paths to whole-project commands, or convert selected-file checks into full-project proof. A fixed `bin/dev lint api` / `bin/dev lint web` binding or `eslint .` script still checks its whole project; `appendPaths` and native changed-file commands retain their narrower scope. This is an explicit lint execution, not automatic requirement/suppression selection. It reruns the supplied selection rather than caching an earlier project's PASS or resuming a killed process.

JSON result arrays and text use `verifier:project-lint`. Completed project outcomes remain in combined evidence alongside the failed/timed-out command. Budget exhaustion and unavailable prerequisites stay BLOCKED; recognized lint findings stay FAIL; PASS requires successful completion of all applicable commands. `--failures-only` hides successful results, and no applicable work produces no result, not PASS. A later recovery result is new evidence for that checkout and scope; it does not rewrite the earlier timeout.

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

1. `automatic` or `verify` normally prepares a fresh request and returns status `PENDING` with `reviewRequest`, both when the review is ready and when recoverable context is still needed. Normal request-intent automatic calls may instead reuse a current accepted result under [Request Intent and Proof Reuse](#request-intent-and-proof-reuse). Successful preparation exits `0`: it supplies review work, not a source verdict or approval. A final `FAIL`/`BLOCKED` result exits `1`. CLI text output with exactly one pending result presents bounded page `0` immediately and records its delivery; mixed results keep separate request handles. JSON remains unchanged for requests not enrolled in text paging.
2. `review <request-file>` returns current captured evidence, scope, provider source, quality standard, and rubric as a full pretty-printed JSON export. Provider source `text` is an array of original lines, while project-record `content` maps original one-based line numbers to exact source text. Use those keys in citations rather than counting JSON entries. `review ... --reporter text [--page <index>]` exposes bounded JSON fragments for model/human inspection, starting at page `0`. The first bounded text presentation enrolls that request; each valid served page records the request path/ID, canonical text-view fingerprint, index, and count. An enrolled request may be evaluated only after every page has been served. If any index is missing, `evaluate` ignores its draft assessment and remains `PENDING`, returning `reviewProgress.nextPage` (the first missing index) and `missingPages`; the CLI text response presents and records that next page immediately. The advisor must inspect every page before judging the full scope: page calls and metadata are delivery/accounting, not proof of comprehension or evidence of scope. Metadata such as matches, evaluation, or review progress does not change the canonical evidence view used for page accounting. JSON-only/API consumers that have not enrolled retain their existing behavior, but switching to JSON after text enrollment cannot bypass the outstanding pages. Page delivery neither renews nor consumes the request.
   `review ... --reporter text --context <project-relative-path>` captures targeted additional files and supersedes the earlier request ID. For a bounded chunk, use a shell-quoted selector such as `--context 'api/tests/README.md#L130-L150'`; repeated selectors retain separate chunks of the same file. Ranged selectors replace a prior whole-file request for that path. Recovery starts on page `0`; read later pages from the renewed path without context options. Invalid page arguments are rejected before recovery can renew a request. Paging does not relax capture, freshness, citations, or the rubric, and does not combine independent per-page verdicts.
   Display lines wrap at 600 UTF-8 bytes, with a backslash at each inserted line break so column limits do not hide source. Remove each backslash-newline continuation without inserting a newline to reconstruct the JSON fragment or execute a page footer's literal `Next command`. Ordinary JSON line breaks remain. Byte offsets address the unwrapped JSON view, and content keys remain original source line numbers. The formatted page budget includes wrapping overhead. Full JSON export does not add display continuations.
   Bounded pages serialize the same evidence without JSON indentation; full JSON export remains indented. Only transport whitespace changes: source strings, fields, and original-line keys are preserved. A different serialized view starts its own receipt accounting; receipts are never copied onto changed evidence.
   Pages presented during preparation or context recovery already count as delivered receipts, so continue from their reported next index rather than requesting page `0` again. Inspect their content as well: delivery accounting does not prove comprehension. On a non-final page, execute its exact returned next-page command; on the final page, execute its exact returned evaluate command with literal assessment JSON on stdin. Remaining readable pages are advisor work, not an unavailable prerequisite or native blocker. Do not deliver progress, native blocker advice, or `Complete.` before an accepted final result. Batch currently known material files/ranges and runner evidence in one recovery call using repeated `--context`/`--caller-context` selectors. Recover an established gap before fetching more pages of an intermediate request that will be replaced, then inspect every page of the final current request. This reuses current captured evidence without skipping required context, weakening freshness, or treating readiness as PASS.
3. The existing model assesses the supplied rubric using actual changed code and relevant project context. Project-local architecture takes precedence. A small meaningful invariant may pass; a trivial extraction is not justified by naming or file size alone. Before submission, the model reconciles status, summary, rationale, citations, and next check against its completed reasoning. A discarded violation hypothesis must not remain a FAIL conclusion alongside compliance reasoning. Unmet criteria support FAIL, complete satisfied criteria support PASS, and genuinely unavailable material evidence supports BLOCKED. Runtime acceptance validates the evidence protocol, not semantic truth or consistency; it does not rewrite statuses from prose keywords.
4. `evaluate <request-file> --assessment -` reads an assessment from stdin. It requires the actual current `requestId`, `status` (`PASS`, `FAIL`, or `BLOCKED`), non-empty `summary` and `rationale`, and `citations` containing a project-relative `path` or an admitted external source's exact URL, original one-based `line`, and exact source `quote`. PASS/FAIL require a matching citation in the changed scope; BLOCKED may explain unavailable evidence without a source citation. Supply the smallest corrective `nextCheck` for failures or blocks.
5. The runtime checks the current request, provider/standard hashes, project context, citations, and (for enrolled text views) complete page-delivery accounting, then consumes an accepted request. Missing page receipts keep the request PENDING rather than admitting the draft assessment. Current source/provider freshness validation still runs before page-accounting admission; once the pages are complete, the normal citation guards apply. Delivery receipts do not substitute for freshness, citations, or semantic judgment. Final results preserve the standard ID/source and quality standard. Only final FAIL/BLOCKED results are delivered through native blocker transport; PASS stays private. Correct the source or apply an allowed bounded reasoned exception, then prepare a fresh evaluation. A planned check, consumed request, superseded assessment, or earlier PASS cannot clear a later change. Native blocker advice is the correction channel, not a native completion veto; this workflow does not fix or guarantee admission for [#150](https://github.com/klondikemarlen/omp-verifier/issues/150).

Invalid assessment input, including a mismatched citation, returns `BLOCKED` with summary `Semantic assessment is invalid` without consuming the request. Read its current evidence, correct the request ID or original-line citation, and resubmit with `evaluate`. This is distinct from `Semantic request is unavailable`, which reports an unavailable or invalid request prerequisite and calls for fresh preparation with the complete original scope and actual delivery base.

If a copied path loses its generation prefix or its request filename is shortened, the command reports an invocation error (exit `2`) without recording a page. Retry the literal `Next command` from the last successful page in the same checkout. The launcher selects the generation; the pinned coordinator interprets its own filenames. A complete request file in another runtime still needs its original coordinator, and a missing pinned generation remains `BLOCKED`. The launcher does not search for similar requests or fall back to the active generation.

### Finding Eligibility

PR-backed semantic requests default to `scope.findingMode: "changed-lines"`. To include unchanged lines of specific PR files in a cleanup review, pass `--whole-file <path...>` with `automatic --base <actual-PR-base>` (`changed-lines-and-files`). A path not in the PR cannot be made eligible by naming it for cleanup. Non-PR requests retain `changed-files` scope. Callers, siblings, guidance, and recovered source can supply evidence without becoming cleanup targets.

For a PR FAIL, supply `findings: [{ "path": "src/changed.js", "line": 7, "summary": "The changed export violates the supplied standard." }]` and an authenticated citation for that path and line. For a regression outside eligible lines, cite the finding and the actual changed introducer, adding `introducedBy`, `introducedByLine`, and `regression` to explain the cause. For a deleted file, cite its captured prior source. Without a PR base, findings require a path citation and retain path-level causal attribution. The reviewer owns causal truth. PASS/BLOCKED cannot carry findings; invalid attribution does not consume the request. Batch failures retain their findings in the final result.

`lineRanges` uses current-source coordinates. Removing lines from a file that still exists does not make the adjacent surviving lines eligible. If a reviewer cannot establish a suspected regression from the captured evidence, report the missing evidence as BLOCKED, not a finding against a nearby line or a PASS for unverified behavior.

Automatic JSON results include `scope` with the checkout, selected paths, and, for delivery-backed checks, base reference and resolved base/merge-base/head commits. Final semantic results preserve their captured scope identity. Text reports show scope identity and findings; complete selected paths remain in JSON. `semantic-findings` identifies validated semantic attribution. `provider-owned` identifies an opaque deterministic result: the coordinator supplies selected paths but does not parse diagnostic prose to remove failures or assert that the provider used changed-line scope. Broader commands and repository audits retain their actual execution contracts.

Requests prepared before finding attribution must be renewed. Delivery-backed reconciliation supplies a new request; other old requests explain the need for fresh preparation. Provider contracts remain version 1 and unchanged. Shared-provider changed-line semantics and native advice admission are separate work, not established by this boundary.

When incomplete caller retrieval or recoverable changed-source ranges are the only required-context gaps, a premature PASS/FAIL draft is not accepted: `evaluate` returns PENDING with the same actionable request path and ID, preserving scope and page receipts. Capture marks retryable changed-source records with `rangeRecovery`; this permits a bounded recovery attempt, not a promise that complete evidence fits or a source verdict. Recover material callers with `review --context` or real runner/discovery evidence with `--caller-context`. For changed source, remove exact oversized or invalid retained selectors with `--remove-context`, add smaller replacement ranges and every reported omitted line (including a final empty line), then inspect every renewed page and assess the complete scope once. Adding smaller overlapping ranges alone does not remove an oversized selector. If targeted recovery establishes a genuinely unavailable material dependency, submit an explicit BLOCKED assessment explaining that prerequisite. Required-capacity failures, other missing-evidence guards, source/citation validation, and unavailable-request failures remain unchanged.

Supersession is an operation lifecycle, not a source defect. Under the same per-check lock, a late `review` or `evaluate` returns the validated pending replacement as `reviewRequest`; every supported result carrying that handle is `PENDING`, whether ready or awaiting recoverable context. `evaluation.requestId` identifies the rejected operation and `evaluation.supersededBy` identifies the current request. Old selectors and assessments are not applied. Reconfirm the complete edit-owned scope, read every replacement page starting at `0`, then assess its current ID; the new request identity starts fresh page accounting. Text review restarts at page `0` even when the obsolete operation requested a later page. If the current request is already consumed, return non-verdict `SUPERSEDED` without replaying its verdict. CLI failure-only output retains both `PENDING` and `SUPERSEDED` for recovery; neither is native blocker advice or evidence of PASS. Current provider/source freshness and tamper validation still run; missing state and genuine final prerequisites can produce `BLOCKED` without `reviewRequest`.

Exact current completed-request retries differ from superseded operations. Acceptance atomically retains the final result alongside the consumed state. `review` and `evaluate` recover that exact result, including its check, request, standard, summary, evidence, and next check, after validating request integrity and current source/provider freshness. A replacement assessment or context selection on the completed handle is not applied. Recovery creates no new request or page-review obligation; the freshness check still inspects current evidence. PASS remains silent with `--failures-only`, while retained FAIL/BLOCKED remain reportable. Legacy consumed state without a retained result cannot establish a verdict and requires fresh preparation.

Automatic delivery recovery establishes current applicability before treating a saved provider failure as a current prerequisite. `automatic --base` records `scope.automatic`: the provider directory and delivery base, resolved base/merge-base/HEAD commits, candidate paths, and selected delivery paths. Both `review` and `evaluate` validate request integrity, reselect against the current delivery, and check source/provider freshness under the per-check lock. Changed scope, provider, source, guidance, or inventory creates a fresh PENDING request with new page accounting; no old assessment is applied, including a previously accepted PASS. Additional context selectors and the source cap remain available on the replacement. Restored candidates and temporary additions absent from the baseline and working tree are excluded; committed deletions remain selected. A check that no longer applies returns non-verdict SUPERSEDED; current required-provider or discovery prerequisites remain BLOCKED. Other checks' failures are not cleared. Explicit named checks, automatic requests without an evidenced base, and legacy requests retain explicit-path selection and stale-request diagnostics. Guidance, callers, siblings, and inventory are context roles, not changed-source membership.

A policy interruption during `review` or `evaluate` leaves the assessment obligation PENDING; policy text, unusable JSON, and a private `Complete.` do not establish completion. The advisor follows the applicable policy, then resumes the targeted operation with current evidence and request identity. When no usable replacement is returned and the applicable scope lacks an observed current final result, an unusable, superseded, or already-consumed request requires fresh preparation of the same complete scope, not reuse of the old assessment. If an actual execution prerequisite prevents completion, report its observed diagnostic and smallest next check as a concrete execution `BLOCKED`, not a source verdict. A retained request handle does not make that prerequisite available or establish approval. Unread pages and recoverable path-copy errors remain actionable pending work. This is continuation guidance, not a policy bypass or native completion veto.

Recovery belongs to the request's `scope.repositoryRoot` and complete `scope.changedPaths`, not a stacked child's checkout or remembered file list. Inspect current source and captured directory membership before selecting dependencies. An absent optional sibling explicitly requested by mistake is a selection error, not evidence that automatic discovery failed or the application needs a phantom file. Additional recovery calls retain earlier selectors. Remove an erroneous selection explicitly with repeatable `--remove-context '<exact-retained-selector>'`, adding valid replacement ranges with `--context`, `--caller-context`, or `--external-context` in the same call. Removal applies to all retained selector lists before additions; other selections and the complete changed scope, including authenticated deletions, remain intact. Unknown removals fail without changing the current request. A successful edit captures current evidence under a new request ID and resets page receipts; inspect the returned page `0` and every remaining page before assessment. Freshness, full-source identity, citation, and evidence limits are unchanged; ranges are not clamped and partial coverage cannot establish PASS. A dependency established by current source or the supplied rubric remains required even when absent: keep the review PENDING while recoverable evidence is captured and use final BLOCKED without `reviewRequest` only when it cannot be recovered. Never omit a required dependency to obtain PASS.

Material public upstream contracts can be admitted with `review --external-context 'https://raw.githubusercontent.com/<owner>/<repo>/<full-40-character-commit>/<path>#Lstart-Lend'`. Resolve a documented version/tag to its actual commit before selection. Remote retrieval supports only explicit immutable raw GitHub sources, not general URL fetching, private credentials, redirects, or mutable branches/tags. A URL passed through local `--context` is diagnosed as external evidence, not as an absent project file; local absolute paths, traversal, and escaping symlinks remain rejected. No document is copied into the consumer repository.

For material private dependencies already available locally, the same option accepts `git+file:///absolute/repository?revision=<full-commit>&path=<repository-relative-file>#Lstart-Lend`. URL-encode the repository path and query values when necessary; quote the selector in shell commands. The selected root, full SHA-1 or SHA-256 commit ID, and file path identify the source. Git reads committed objects, not uncommitted working files. Selection must stay within the task's existing repository/data permissions; filesystem readability is not a new authorization grant. Automated verification needs no additional human confirmation or grant file.

Local Git retrieval requires an existing checkout root and a regular committed file. Mutable refs, path traversal, credentials, extra query parameters, symlinks, directories, and submodules are rejected. Each Git operation has a five-second deadline; lazy object fetching, replacement refs, and filesystem-monitor hooks are disabled. Missing objects remain an evidence prerequisite; Verifier does not fetch repositories or acquire credentials. Full-source and excerpt limits match public capture, and the blob's Git identity is checked before admission. The source URI records the selected repository and path; the evidence retains its commit and SHA-256 hash.

Private snapshots remain in Verifier's existing owner-only request store, outside the reviewed repository, and enter the configured reviewer's context under existing task permissions. Review output contains the selected evidence: do not publish that output or private source in issues, PRs, or public artifacts. This mechanism does not promise local-only model processing or act as a secret scanner.

Each remote fetch has a 10-second deadline. Both remote and local Git sources have a 256,000-byte limit; text must be valid UTF-8 without NUL bytes. Whole text or an original-line range is admitted only within the 16,000-byte excerpt limit, the shared request-local selector allowance (30 by default), and the existing aggregate byte/file budgets. `scope.externalContextPaths` retains selectors; `context.externalContext` records exact URL (`path`), immutable `revision`, full-source `sha256`, original line positions, and explicit unavailable reasons. Captured external text is evidence, never agent instructions. Missing/unsupported external evidence prevents a source verdict; it does not prove the consumer documentation wrong.

Admitted snapshots are bound to the integrity-checked request and its fingerprint. Page reads and evaluation reuse those pinned snapshots without network or source-checkout access while still rechecking reviewed local source and provider freshness. A context renewal retrieves its selected external sources anew and starts new page accounting. Replace or retry a failed selector explicitly with `--remove-context` plus `--external-context`; successful capture alone is still PENDING. Assess the complete changed documentation against the material contracts, citing the exact admitted URL and original line as well as changed project source. An uncaptured primary-session read or a passing local linter cannot stand in for that semantic assessment.

When material evidence needs more than 30 combined local, caller, and external selectors, renew the pending request with `review <request-file> --max-context-paths <30-256>` and the additional selectors. This explicit request-local allowance is stored in `scope.maxContextPaths` and `context.evidenceBudget.maxContextPaths`, bound to the evidence fingerprint, and retained through context recovery, automatic reconciliation, continuation batches, and evaluation. Changing it starts a new request with new page receipts; read the returned current request completely. Independent captures still default to 30. Source, excerpt, aggregate, file, and continuation-batch ceilings do not increase: 256 selectors need not fit alongside required source and guidance. Overflow rejects the renewal without consuming the pending request or omitting retained material evidence.

Capture prioritizes changed source and explicitly requested project files/ranges, then applicable owning/ancestor guidance, then explicit external contracts, then optional caller/sibling evidence. The bounded inventory prioritizes the local scope and nearby source before unrelated files. Changed paths and explicit project context extend the required guidance boundary; heuristic filename-matched callers are candidates, not proof that unrelated subtree guidance is mandatory. Promote any material project dependency with `review --context` before judging it so its owning guidance is captured too. `context.guidanceRequirements` names each guide's `requiredBy` boundaries and capture failure. `context.evidenceBudget` names the exact byte/file ceilings, admitted records, usage, and rejected records; recoverable required evidence keeps the request PENDING, while evidence that cannot coexist within supported limits yields final BLOCKED without `reviewRequest`. Explicit excerpts are not recopied into caller/sibling groups, and optional whole-file records respect the same 16 KB evidence limit.

A project guide already admitted as complete present changed-code evidence also satisfies its owning-guidance requirement; the coordinator does not recopy it into a separate guidance record. An authenticated deletion admitted as changed source is historical evidence, not live instructions, and no longer requires guidance at its removed path. Surviving applicable guides remain required. Partial, unavailable, or over-budget changed source cannot discharge a live-guidance requirement. Recover the complete changed guide with bounded original-line selectors before assessment; freshness and citation checks still use its captured source.

Confirmed deletions retain their prior captured or Git source, including a previously observed untracked helper removed during correction. With an empty capture cache, committed deletions recover the exact source from the first parent of the latest deletion on HEAD's first-parent history, including merge deletions and later unrelated commits. Git lookup has a five-second command deadline and the request's recorded source ceiling: automatic chunk recovery permits up to 256,000 bytes, while manual/explicit-override capture retains its whole-source cap. Oversized authenticated source has a size diagnostic distinct from unavailable history; unavailable or shallow history, binary source, and absent files without authenticated prior source cannot establish a source verdict. Retained deleted text counts against the same aggregate byte/file budget as present source. Original-line citations and `previousSha256` identify deleted source without restoring it.

Retrieval limits remain operational bounds, not semantic verdicts: up to 1,200 inventory files and 8 MB of inventory reads; ordinarily 40 distinct evidence files and 256,000 bytes of captured evidence; 16 KB per whole-file record or requested excerpt. When the distinct union of changed paths, explicit material-context paths, and their owning guidance exceeds 40, capture selects a 256-file / 1,024,000-byte large-scope budget before admission. Required records also select that same bounded larger tier when their admitted content would cross 256,000 bytes, including complete recovered chunks and authenticated deleted source. Heuristic callers and optional siblings cannot trigger growth. `context.evidenceBudget.requiredFiles` reports the required-path cardinality alongside the effective ceilings, usage, and exact rejections. Required-scope capacity diagnostics distinguish those failures from optional omissions: recover material ranges with `review --context` when they can coexist, retain complete changed-source coverage, and keep the result PENDING while supported recovery remains possible. Required evidence beyond the larger byte or file ceiling remains unapproved until supported recovery, including explicit [bounded continuation](#bounded-semantic-continuation), admits it; do not create independently final shard verdicts or drop required records. Explicit selectors share the request-local allowance (default 30, explicitly configurable up to 256) and may each request at most 500 original lines; ranged identity retains the 256 KB per-source ceiling. Bare explicit files retain the 16 KB limit. Without automatic source recovery, oversized applicable guides initially expose up to 120 lines when that excerpt fits; default automatic checks instead capture complete required guidance in bounded chunks. One current request and final verdict cover the complete scope; larger capture never implies PASS.

Fresh automatic checks without `--max-source-bytes` admit required present/deleted source and guidance through deterministic complete line chunks. `scope.sourceRecovery` records the effective policy: at most 16,000 UTF-8 bytes per chunk and 256,000 bytes per source, still subject to aggregate/file ceilings. Chunks preserve full-source identity, original line positions, final empty lines, and coverage; they are records within one semantic obligation, not independently approved fragments or extra operator selectors. Explicit partial selectors remain partial. Source beyond the whole-source ceiling, a single line beyond the chunk limit, unavailable history, and exhausted aggregate capacity remain diagnosed gaps; repeated unchanged capture cannot solve them.

For material records in large unchanged local files, use explicit ranges rather than increasing the whole-source cap. For example, recover a resolved dependency with `review <request-file> --context 'api/package-lock.json#L200-L210' --context 'api/node_modules/example/index.js#L1-L60'`, substituting the actual dependency record and its matching installed public API source. Local range capture streams and hashes up to 8,000,000 source bytes while retaining at most 16,000 normalized UTF-8 excerpt bytes; selectors still span at most 500 lines and share the existing selector and aggregate evidence budgets. Whole-file admission and automatic whole-source recovery limits are unchanged. Changes anywhere in the streamed source invalidate its evidence, including outside the selected range. Missing API source, paths resolving outside the project, binary content, over-budget excerpts, and scan-limit exhaustion remain explicit prerequisites. Use supported pinned external context for a public contract outside the checkout rather than copying a manifest assertion into synthetic evidence. Capture does not prove API compatibility, and a partial selector cannot discharge complete changed-source coverage or expand the active delivery scope.

Explicit ranges use the same bounded streaming scanner for a present changed file above the automatic whole-source ceiling. Supply every original line, including a final empty line, across bounded selectors; a partial selection cannot establish complete changed-source coverage. All ranges must share one full-source identity, and source changes invalidate the review. This does not increase selector, excerpt, aggregate, or continuation-batch limits: recovering one large source does not guarantee that its complete review bundle fits.

OMP 18.19.0 does not expose the named advisor's model context window through the coordinator's Bash interface. Its shared extension tool hook overrides agent identity, not the primary-session model accessor. Recovery records `modelContext: "unavailable"` and retains the byte ceiling rather than substituting primary-model or guessed catalogue metadata. Token context capacity and source bytes are different units; bounded chunks do not solve accumulated advisor context overflow or certify room for an entire review.

Fresh `automatic` and `verify` captures accept `--max-source-bytes <bytes>` as an explicit one-off whole changed-source cap, including historical Git-backed deletions. Values must be decimal safe integers from 16,000 through 256,000; for example, a 32,768-byte cap admits a complete 16,229-byte committed deletion without restoring it. An explicit flag retains whole-source-cap mode rather than enabling automatic chunk recovery. The effective value is recorded in `scope.maxSourceBytes` and `context.evidenceBudget.maxSourceBytes`, bound to request identity/freshness, and preserved through context renewal and assessment. `review`, `evaluate`, and `checks` cannot change it. Later independent automatic capture without the flag uses the bounded recovery policy; manual `verify` returns to its 16,000-byte whole-source default. Legacy requests without a recovery policy retain their original behavior. Explicit context, guidance/caller discovery, aggregate byte/file budgets, and unrelated safety limits are unchanged. Capture never establishes semantic approval.

`context.siblingInventory` records each changed parent directory's source-file list and enumeration completeness independently of the global source inventory. A completely inspected directory with no other source files supplies valid empty-sibling evidence even when unrelated repository inventory is truncated. Directory enumeration shares a separate 1,200-entry budget across changed directories, counts non-source entries, stays inside the project, and reports unreadable or uninspected boundaries as incomplete. Nonempty boundaries still require captured sibling evidence or explicit material source context, not every listed file's contents. Scoped sibling completeness never establishes global caller coverage; directory membership is included in request freshness validation.

When a changed directory is absent, sibling discovery authenticates each deleted source through Git and inventories the corresponding index or historical trees within the same entry budget. The recorded snapshot hashes participate in freshness checks. A fully deleted boundary needs no live directory or restored helpers; omitted historical siblings still require material evidence. Missing history, unsafe ancestors, and exhausted retrieval limits remain incomplete rather than proving empty siblings. Cached source alone cannot authenticate a missing directory's inventory.

For historical siblings moved by a Git-detected rename, discovery records `renames` with the old path, current destination, and historical reference. It captures representative evidence at the current destination and includes that destination's owning guidance. Source already captured as changed code, targeted context, or a caller can satisfy the historical boundary without duplication. Complete changed scope still retains the old deletion and new source; rename provenance and current source participate in freshness checks. Unproven moves do not justify guessing a replacement path or treating missing siblings as empty.

After required source and guidance, capture reserves one available sibling representative per changed directory before admitting broad filename-matched callers and remaining siblings. Explicitly captured source can satisfy that reservation without duplicate records. `context.siblings` reports `none-found` only after complete empty-directory discovery; `not-captured` means siblings exist but no source was admitted, `unavailable` means discovery could not establish absence, and `captured-elsewhere` points to source already present in targeted or caller records. Arrays contain directly captured sibling records. Missing-context diagnostics name incomplete directories and candidate paths; `context.evidenceBudget.rejections` retains file-count, aggregate-byte, and per-file capture-limit reasons. Recover material source with `review --context <path[#Lstart-Lend]>` while retaining the complete changed scope; clearing acquisition gaps does not itself complete semantic assessment.

Caller recovery distinguishes source importers from runtime entrypoints. `review <request-file> --caller-context <project-relative-path[#Lstart-Lend]>` labels captured runner configuration/discovery or caller source explicitly, without requiring a literal changed-filename match. Use real project files such as a runner's package script plus its discovery configuration; do not add artificial importers or documentation. The selectors share the request-local selector allowance (default 30, explicitly configurable up to 256), source, record, and total-evidence budgets with `--context` and `--external-context`, renew the request ID, extend owning guidance, and remain in freshness validation across later renewals. A changed file cannot serve as its own caller evidence.

This supplies material context for the model's scoped applicability judgment, not an automatic entrypoint/no-caller verdict. The model must establish discovery/applicability from that actual source, explain whether source callers are material, and keep the request PENDING while recoverable material caller evidence is obtained. If required caller evidence cannot be recovered, return final BLOCKED without `reviewRequest`. PASS/FAIL using explicit caller context require exact citations to both the changed scope and captured caller/runtime source. `context.callerRetrieval` reports the 1,200-file and 8 MB read bounds, inspected/omitted counts, up to 30 omitted path examples, exact unreadable-source reasons, and recovery instructions. `sourceInventory.complete` remains independent and false when global acquisition is incomplete; a runtime entrypoint assessment never establishes globally complete caller coverage.

Partial records expose `startLine`, full `lineCount`, `partial`, and `omittedRanges`. Full-source hashes invalidate a request when source outside an excerpt changes, and citations must match a captured original line in one of its chunks. Omitted optional evidence and incomplete inventories remain explicit; neither implies complete caller or guidance coverage. `evidenceTruncated.siblings` or rejected optional siblings alone do not establish a semantic blocker. Select material files/ranges with `--context` and real runner source with `--caller-context`, then inspect the renewed `missingContext`, guidance requirements, and evidence-budget records before assessment. For a migration, prior schema and a relevant recent backfill can be material even when unrelated historical migrations fill the initial window. A budget blocker identifies the particular material evidence that remains unavailable after targeted recovery and why the rubric needs it; it does not demand a larger budget or new runtime when current selection suffices. Recoverable required evidence remains PENDING; evidence that cannot be recovered is final BLOCKED without `reviewRequest`. An empty `missingContext` permits judgment rather than establishing PASS.

Without automatic source recovery, a required changed file exceeding the effective whole-source cap initially remains unavailable. Recover present source with repeated `review --context 'src/module.js#L1-L120'` selectors covering all original lines; explicit historical whole-source overrides retain their separate authorization contract. Default automatic checks instead capture supported required source in bounded chunks without manual selectors. In either chunked path, `context.changedCodeCoverage` exposes each recovered path's `lineCount`, `coveredRanges`, `omittedRanges`, and `complete` state. Only complete admitted coverage clears the required changed-code gap; a valid citation or a union with even one omitted line cannot establish PASS/FAIL. Each admitted chunk retains its original line numbers and the full current source hash. Recovery stays within its recorded policy and does not change the supplied rubric; the request stays PENDING while supported recovery can complete coverage and yields final BLOCKED without `reviewRequest` if the source cannot fit.

Requests are private, atomically written, per-project operational cache, not a knowledge store or reusable PASS cache. Per-check locks serialize overlapping preparation/completion. Process-lifetime leases release when the owner exits. An existing lock from an older coordinator is never stolen: finish the owner operation or confirm its recorded PID has exited before removing an abandoned legacy lock.

### Bounded Semantic Continuation

Default capture and assessment behavior are unchanged. When required evidence cannot coexist within the aggregate budget, `review <request-file> --continue [--reporter text]` explicitly renews the complete original obligation into bounded batches. `--continue` is a boolean review-only option, starts at page `0`, and cannot combine with `--batch`; repeating it on a continuation request restarts capture and invalidates all checkpoints and page receipts. It is not a resume flag. Required changed paths are partitioned deterministically into captures whose disjoint union equals the original scope. If one required source bundle exceeds a batch, its captured original-line records are distributed across evidence batches sharing one capture identity. Required applicable guidance and material context may occupy separate batches but remain mandatory for final integration, including authenticated deletion/rename provenance and pinned external snapshots. Optional omissions alone do not trigger partitioning.

Continuation has fixed limits: at most 32 batches, each with at most 256,000 captured UTF-8 bytes and 256 evidence files, including optional admitted records. A larger capture is bounded by the combined batch allowance and is partitioned before presentation. Existing source, chunk, selector, inventory, and citation limits still apply. One evidence record exceeding a batch requires bounded original-line recovery; a scope exceeding 32 batches remains an actionable capacity prerequisite. Continuation does not drop required source. Rendered text pages still fit 24,000 UTF-8 bytes including headers, commands, and display wrapping.

`reviewRequest.scope.changedPaths` always names the entire original scope. `reviewRequest.continuation` identifies `phase` (`batch` or `aggregate`), zero-based `batchIndex` (null in aggregate phase), `batchCount`, fixed `limits`, and a bounded `batches` ledger. Each ledger entry exposes its capture identity, paths, context fingerprint, guidance paths, byte usage, captured evidence record locations, and any accepted checkpoint's status, rationale, citations, and cross-batch notes; it does not duplicate other batches' raw source. `reviewRequest.context` contains the active batch's evidence or the final bounded ledger, and `missingContext` retains unresolved requirements for the complete capture, not a claim that each batch independently contains the entire source.

For a batch, inspect every page, then submit the usual assessment JSON plus integer `batchIndex` and nonempty `crossBatchNotes` of at most 4000 characters. The entire serialized checkpoint, including those notes, must fit 8000 UTF-8 bytes. Cite evidence actually present in that batch, including guidance-only or material-context-only evidence, and preserve unresolved interactions for final integration. Final assessments still require changed-scope citations and explicit caller-context citations when applicable. An accepted checkpoint returns PENDING with the next batch or aggregate phase; it neither consumes the obligation nor approves a source fragment. Page receipts include batch identity as well as request/view identity, so one batch's delivered pages cannot satisfy another. Every next-page command preserves `--batch N`.

After all checkpoints, assess the whole original scope and cross-batch interactions explicitly. The final assessment omits `batchIndex`, includes `coveredBatches` with every exact batch index, and explains integration in its rationale. Final PASS/FAIL require every checkpoint; PASS is prohibited when any batch is FAIL/BLOCKED. A genuine unavailable prerequisite can terminate honestly as BLOCKED. For source reinspection, `review <current-request-file> --batch N --reporter text [--page N]` selects any saved batch without resetting progress; `--batch` is review-only and requires a nonnegative safe integer. Final citations can refer to captured source from any batch, using original paths, line numbers, and exact quotes, not ledger summaries.

Ordinary `review <current-request-file> --reporter text` resumes saved progress, including manually from a fresh process; retain the exact current request path and do not repeat `--continue` to resume. Source/provider freshness still applies across every batch, including already checkpointed source and guidance. Material changes renew the request and invalidate all checkpoints and receipts; old assessments cannot approve new evidence. This feature neither restarts the host nor changes scheduling, models, routes, or cumulative model context. Captured-byte limits and delivery receipts are not token-window estimates or guarantees; bounded continuation does not fix [#206](https://github.com/klondikemarlen/omp-verifier/issues/206).


### Transient Source Handoff

A temporary smoke script can be executed and cleaned up before the first model assessment. Set `coordinator` to the installed `bin/omp-verifier.js` path shown in the generated `<agent-dir>/verifier/WATCHDOG.md`; the package's CLI name need not be on the shell's PATH. Before deleting the script, explicitly prepare its source:

```bash
node "$coordinator" automatic 'api/.review-smoke.ts' --reporter json
```

Run this after the script's final edit and execution, immediately before cleanup. Inspect the semantic result's `reviewRequest.context.changedCode`: it must contain that exact path's complete source, either as one whole-file record or as contiguous chunks whose `changedCodeCoverage.complete` is true. Chunk reassembly must cover every original line and match each record's full-source hash; partial coverage cannot authenticate a later deletion. All records must fit the request's effective source and evidence bounds. A semantic result carrying `reviewRequest` is `PENDING` whether ready or awaiting recoverable context; it is not a semantic failure or PASS. Preserve any actual deterministic final FAIL/BLOCKED results returned alongside it. Do not clean up source that has not been captured completely within the existing bounds.

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

With `automatic --base`, executable providers also receive `OMP_VERIFIER_PR_SCOPE` as version 1 JSON. `baseCommit`, `mergeBaseCommit`, and `headCommit` identify the comparison. `mode`, `lineRanges` (path to inclusive one-based `[first, last]` pairs), `wholeFilePaths`, and `deletedPaths` describe eligible locations within the provider's matching paths. Without a PR scope the variable is removed, even if inherited. Providers decide how to use it; their reported failures are never filtered by parsing diagnostic text.

Automatic eligibility is a policy decision, not a check result. `automatic-selection.js` consumes validated discovery and project-policy inputs to merge trigger and requirement matches, apply scoped suppressions, and identify missing providers without executing checks. The coordinator owns input discovery and validation, then executes only the resulting unsuppressed selections through the existing executable or semantic path. Keep selection precedence in that policy and execution side effects in the coordinator; selecting a check never establishes PASS.

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

One native review can combine deterministic results with semantic assessments completed by later coordinator calls. Each accepted assessment updates only its own check result; a later PASS or empty failure-only response does not clear another check's failure. Complete all applicable work and any handoff finalization before delivering every still-current FAIL/BLOCKED together in one native blocker note. Successful native delivery ends the review, so sending separate notes can lose the remaining results. This aggregation is advisor guidance, not a runtime-enforced delivery guarantee.

Native Verifier advice must come from the named reviewer's own executed check for the applicable trigger, owning checkout, and current scope; semantic advice uses the accepted final result rather than the submitted assessment. A report quoted in primary tool output, a fixture, or a child-session transcript is evidence to inspect, not the outer reviewer's result to deliver. Completion-only updates do not reopen a finished review or authorize replaying earlier blockers. Genuine current failures still require delivery: the primary owns project repairs, while Verifier runs checks and supported review-evidence recovery. This is model-mediated guidance, not a runtime-enforced provenance gate.

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

The [README release procedure](../../README.md#development-and-release) owns native QA execution. Evidence belongs to one current scenario: selected paths, check and request identity, final coordinator result, completed named review, delivered blocker, primary remediation, and fresh corrected-scope result. An earlier private final, unrelated result, or settled primary RPC prompt cannot substitute for current named-review completion.

Loading, review completion, and host settlement are separate boundaries. A status-only probe can establish plugin registration and model resolution without exercising provider availability or semantic assessment. An unattended completion gate additionally requires one user request to drive failure, blocker delivery, repair, and fresh current PASS before settlement; a follow-up work prompt or unrelated continuation trigger does not prove that gate. Its dependency and reproduction record belong in [#150](https://github.com/klondikemarlen/omp-verifier/issues/150).

Transcript inspection supplies QA evidence, not a supported extension-completion API. [OMP #15422](https://github.com/can1357/oh-my-pi/issues/15422) owns the requested per-review outcome handoff. The shared [Real Async Runtime Barriers in Integration Tests](https://github.com/klondikemarlen/marlens-skills-rules-and-tools/blob/main/docs/references/engineering-techniques-reference.md#real-async-runtime-barriers-in-integration-tests) owns the general synchronization technique.

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
