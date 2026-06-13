# Changelog

All notable changes to this project will be documented in this file.

This project is pre-1.0 and has not published a formal open-source release yet.

## Unreleased

- Added local CI, package build, export smoke tests, and tarball content verification.
- Added source hygiene checks for tracked generated files, local artifacts, broad TypeScript suppressions, and unsafe casts.
- Added toolchain verification for Node.js and npm, including GitHub Actions npm pinning before dependency installation.
- Added CLI startup and argument-validation smoke checks.
- Added repository hygiene checks for generated files and local environment templates.
- Fixed repository hygiene checks so `.env.example` can be tracked while real `.env` files remain blocked.
- Added support, code of conduct, editor, and npm engine-strict project configuration.
- Added deterministic maintenance scenario runtime checks with a fake LLM, covering booking happy path, cancellation, multi-vehicle selection, time-change invalidation, draft follow-up, explicit previous-dealer selection, no-availability fallback, prefetch connector failure isolation, command connector failure, and no-vehicle fallback.
- Fixed same-turn invalidation so later derived source fields do not clear dependent fields explicitly extracted from the user's latest message.
- Added package-level README files for `@pac/workflow` and `@pac/engine`.
- Added contribution, security, and release process documentation.
- Added local unit coverage for workflow acknowledgements, connector contracts, program builder rules, patching, and engine runtime behavior.
- Tightened connector public types to avoid exposing `any` while preserving schema-validated registry calls.
- Added API documentation coverage checks for public runtime exports and key public types.
- Fixed publish-readiness path resolution for workspace package lifecycle execution and added a lifecycle guard.
- Split engine node execution into separate prefetch/effect result application paths for clearer runtime responsibilities.
- Moved engine internal JSON, logging, message, rendering, state, and turn-change helpers into focused `utils/` modules.
