# Changelog

## 0.1.1 - 2026-07-07

- Replaced the WRAP-specific verifier prompt with a generic project verifier prompt that reads local repo conventions first.
- Updated `/verify-pr` to hand off to the project-aware verifier and require local conventions before checks.
- Added `WATCHDOG.md` for advisor-style always-on verifier review through OMP's built-in advisor runtime.
- Added concepts documentation for verifier workflow, install lessons, release flow, and current runtime limits.
- Documented setup, `/verify-pr`, `/verifier-info`, local linking, private SSH install recovery, OMP docs, and per-project customization.
- Added release verification guidance for clean SSH reinstalls, explicit commit pins, package-version checks, and installed-tree checks before claiming a remote plugin release works.

## 0.1.0 - 2026-07-07

- Added verifier and WRAP verifier task-agent prompts.
- Added OMP extension command wiring for `/verify-pr` and `/verifier-info`.
- Added planning tools for verification plans, app boot envs, and PR comment text.
- Added remote SSH install instructions for the private GitHub repo.
- Added smoke coverage for extension registration and command/tool behavior.
