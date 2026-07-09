# Changelog

## 0.6.8 - 2026-07-09

- Added `/verifier init-local [replace]` for project-local verifier guidance scaffolding.

## 0.6.7 - 2026-07-09

- Added verifier guidance to apply repo-local test standards before approving changed test files.
- Made the README `/verifier status` example version-neutral.

## 0.6.6 - 2026-07-09

- Added copyable project-local verifier rule examples for targeted tests, browser QA, service prerequisites, and high-risk areas.

## 0.6.5 - 2026-07-09

- Replaced SSH-only install guidance with public GitHub install guidance and documented the public package-surface audit.

## 0.6.4 - 2026-07-09

- Added verifier guidance to flag mixed dependency manifest/lockfile changes with unrelated source changes when local or global commit rules require isolated dependency-resolution commits.

## 0.6.3 - 2026-07-08

- Added baseline code-quality guidance from WRAP conventions: readability, low complexity, separation of concerns, domain modeling, and intentional duplication.

## 0.6.2 - 2026-07-08

- Removed duplicate `/verifier doctor`; `/verifier status` now includes plugin version and readiness metadata.

## 0.6.1 - 2026-07-08

- Made `npm run reinstall` uninstall the existing plugin before installing the current pushed commit, avoiding Bun dependency-loop failures.

## 0.6.0 - 2026-07-08

- Added `/verifier doctor` readiness output with installed plugin version, replace-option availability, and status evidence.
- Split project customization into `WATCHDOG.local.md`, imported by the generated `WATCHDOG.yml` wrapper and preserved on uninstall.

## 0.5.2 - 2026-07-07

- Added explicit `replace` install option for overwriting customized verifier `WATCHDOG.yml` files.
- Added a generated `WATCHDOG.yml` marker and migration for serialized quoted-string verifier wrappers.
- Documented post-release remote reinstall as required before claiming an installed release.

## 0.5.1 - 2026-07-07

- Reworked `/verifier status` to show a concise summary plus path-bearing file details for manual inspection.

## 0.5.0 - 2026-07-07

- Changed generated `WATCHDOG.yml` to configure the default advisor with verifier guidance instead of adding a second `Verifier` advisor.
- Preserved customized `WATCHDOG.yml` files during install and uninstall; old generated rosters still migrate or remove cleanly.

## 0.4.0 - 2026-07-07

- Replaced `/verifier info` with `/verifier status`.
- Added status reporting for active agent dir, global/project `WATCHDOG.yml`, global `config.yml`, and project `.omp/config.yml`.

## 0.1.9 - 2026-07-07

- Added second-layer completions for `/verifier install local|global` and `/verifier uninstall local|global`.
- Removed the `--force` option; install and uninstall now apply to the targeted verifier files directly.
- Documented using `Scope: project` in advisor configuration to view project-level advisors after a global install.

## 0.1.8 - 2026-07-07

- Added `/verifier install global` and `/verifier uninstall global` for user-level `WATCHDOG.yml` setup.
- Made install refresh the targeted generated `WATCHDOG.yml` by default.
- Preserved project-local install behavior as the default.

## 0.1.7 - 2026-07-07

- Added `/verifier` subcommand completions for `install`, `uninstall`, and `info`.
- Documented the lightweight feature workflow and release pattern.

## 0.1.6 - 2026-07-07

- Changed generated `WATCHDOG.yml` to keep OMP's default advisor and add `Verifier` as a second advisor.

## 0.1.5 - 2026-07-07

- Replaced bootstrap-specific slash commands with `/verifier install`, `/verifier uninstall`, and `/verifier info`.
- Added safe uninstall behavior that removes generated verifier files and preserves customized project config.

## 0.1.4 - 2026-07-07

- Reduced the plugin to advisor injection only: `/verifier-bootstrap`, `/verifier-info`, and upstream `WATCHDOG.md`.
- Removed verifier task agents, PR handoff, planning tools, app boot planning, and PR comment formatting.
- Stopped hard-coding the advisor model; bootstrap now uses the user's default advisor model.

## 0.1.3 - 2026-07-07

- Added `/verifier-bootstrap [--force]` to scaffold project-local advisor config and `WATCHDOG.yml` importing upstream verifier rules.

## 0.1.2 - 2026-07-07

- Switched remote reinstall verification from Bun tag refs to explicit commit pins after Bun failed to resolve the pushed `v0.1.1` tag.

## 0.1.1 - 2026-07-07

- Replaced the WRAP-specific verifier prompt with a generic project verifier prompt that reads local repo conventions first.
- Updated `/verify-pr` to hand off to the project-aware verifier and require local conventions before checks.
- Added `WATCHDOG.md` for advisor-style always-on verifier review through OMP's built-in advisor runtime.
- Added concepts documentation for verifier workflow, install lessons, release flow, and current runtime limits.
- Documented setup, `/verify-pr`, `/verifier-info`, local linking, SSH install recovery, OMP docs, and per-project customization.
- Added release verification guidance for clean SSH reinstalls, explicit commit pins, package-version checks, and installed-tree checks before claiming a remote plugin release works.

## 0.1.0 - 2026-07-07

- Added verifier and WRAP verifier task-agent prompts.
- Added OMP extension command wiring for `/verify-pr` and `/verifier-info`.
- Added planning tools for verification plans, app boot envs, and PR comment text.
- Added remote SSH install instructions for restricted GitHub access.
- Added smoke coverage for extension registration and command/tool behavior.
