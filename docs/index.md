# OMP Verifier Documentation

This package keeps its user and release guidance at the repository root; durable architecture material lives under `docs/references/`.

- [README](../README.md) — product scope, installation, commands, configuration, and release QA.
- [Committing](../COMMITTING.md) — scoped commit-message and release-branch rules.
- [Verifier Concepts Reference](references/verifier-concepts-reference.md) — advisor lifecycle, discovery and execution inputs, result/evidence semantics, ownership boundaries, and source/test proof map.

## Authority and Publication

The concepts reference links current implementation and tests: source defines observed behavior, and tests are evidence only for the scenarios they exercise. The README remains the user-facing product and release guide.

This repository is public and is the publication boundary for these docs. If a documentation site is added, select its public inputs explicitly with an allowlist rather than publishing the entire `docs/` tree implicitly.
