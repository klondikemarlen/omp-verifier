# OMP Verifier Concepts Reference

## Product shape

OMP Verifier is a second advisor, not a replacement for OMP's default advisor.

```mermaid
sequenceDiagram
  participant Main as Primary agent
  participant Verifier as Verifier advisor
  participant CLI as Automatic coordinator

  Main-->>Verifier: completed changed turn
  Verifier->>CLI: run packaged coordinator
  CLI-->>Verifier: structured results
  alt FAIL or BLOCKED
    Verifier-->>Main: advise blocker with evidence and next check
    Main-->>Verifier: remediated turn
  else PASS, SUPPRESSED, or no result
    Verifier-->>Verifier: stay silent
  end
```

The user-level `WATCHDOG.yml` always keeps `default` first. The plugin inserts and owns only its marked `verifier` block immediately after `default`; independent advisors remain untouched.

`default` receives OMP's stock advisor prompt. On every setup, `verifier` copies this repository's `WATCHDOG.md` to `<agent-dir>/verifier/WATCHDOG.md`, substitutes the coordinator path derived from the installed package, and imports that generated file. The generated verifier advisor receives `bash`; generic quality, scope, strategy, and direct-risk concerns remain with `default`.

## Lifecycle

- Loading the plugin refreshes the agent-owned guidance file and reconciles the user roster to `default`, then marked `verifier`.
- After a changed turn, the verifier advisor invokes the packaged automatic coordinator. The plugin has no `agent_end` notification runner.
- `/verifier status` reports global and project roster entries plus the guidance-file path.
- `/verifier uninstall` removes only the marked verifier block and unchanged guidance file.
- The plugin does not create project configuration, local-rules templates, task agents, daemons, or custom agent loops.

## Requirement contract

A project requirement belongs in a project `WATCHDOG.yml` `verifier` entry. It must name its trigger, Gold condition, narrow check, and PASS evidence.

The verifier classifies applicable evidence as `PASS`, `FAIL`, `BLOCKED`, or scoped `SUPPRESSED`. `PASS`, `SUPPRESSED`, and no applicable results stay silent. `FAIL` and `BLOCKED` produce standard OMP blocker advice with the check id, evidence, and smallest next check.

## Verification capability direction

The plugin remains an independent advisor and does not require an OMP-core API. Installed OMP plugins opt into deterministic verification through package metadata. The package-local `automatic` coordinator handles selection and execution; the advisor owns interpretation and corrective delivery. Packages are eligible when they expose either `omp.extensions` or `pi.extensions`; verification declarations live under `omp.verifications`.

## Manifest contract

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

Each verification entry is a package-relative `.mjs` module. The verifier executes it with the active project as its working directory and expects one JSON result:

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

## Learner promotion path

`omp-learner` captures high-confidence style and concept feedback in OMP memory and reviewable tickets. It must not silently turn an observation into executable policy. The intended promotion path is:

```text
user correction or repeated feedback
  -> learner memory and/or reviewable ticket
  -> accepted shared rule or project rule
  -> explicit deterministic manifest or agentic verifier guidance
  -> verifier evidence
```

Deterministic checks belong in manifests when a rule has a bounded, reproducible signal. Subjective readability, architecture, and concept checks remain agentic guidance and require changed-file evidence plus a concrete local rule or example.

## Related feature tickets

- `klondikemarlen/omp-verifier#82` — consume installed plugin verification manifests.
- `klondikemarlen/marlens-skills-rules-and-tools#227` — expose reusable Marlen-specific checks.
- `klondikemarlen/omp-learner#99` — promote accepted lessons into reviewable verifier-check proposals.

## Release

Release ownership runs issue → issue-named branch → linked draft PR → complete self-review → focused QA and `npm run release:check` → resolved feedback and required checks → merge commit → synchronized `main` → remote reinstall → fresh-process installed behavior.

Advisor-correction claims additionally require a resolved verifier model in `/advisor status`, a packed or remotely installed failing-check scenario, observed verifier blocker delivery, primary-agent remediation, and a clean follow-up coordinator result. `PASS`, `SUPPRESSED`, and no results must remain silent; incomplete remediation must be checked across `advisor.immuneTurns`.
