# Committing

Use Marlen's OMP plugin commit style.

## Format

`:emoji: Verb phrase.` — imperative mood, subject line ends with a period.

The subject describes the outcome or user-visible effect, not just the files changed.

Examples:

```text
:hammer: Scaffold evidence-first OMP verifier agents.
:ok_hand: Trigger verifier turns from the PR command.
:memo: Document remote plugin installs.
```

## Emoji guide

- `:sparkles:` — new user-facing capability.
- `:ok_hand:` — adjustment or small behavior fix.
- `:hammer:` — tooling/plugin infrastructure.
- `:memo:` — docs and release notes.
- `:recycle:` — structure-preserving refactor.
- `:bug:` — defect fix.
- `:white_check_mark:` — test coverage.

## Before committing

Run:

```bash
npm run release:check
```

Then install from the remote if the change affects plugin loading:

```bash
npm run reinstall
```
