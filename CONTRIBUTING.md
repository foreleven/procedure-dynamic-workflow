# Contributing

This repository is moving from an experimental workflow runtime toward a maintainable open-source project. Keep changes small, verified, and aligned with the package boundaries.

Current public-release readiness is tracked in `docs/OPEN_SOURCE_READINESS.md`.

Read `CODE_OF_CONDUCT.md` before participating in public project spaces, and use `SUPPORT.md` to choose the right support channel.

## Local Setup

```bash
npm ci
npm run ci
```

`npm run ci` is the default local quality gate. It verifies the local toolchain, type-checks source files, builds both packages, runs local unit tests, and verifies package exports.

Use Node.js `>=24.0.0` and `npm@11.12.1`; the root package metadata and CI are pinned to that toolchain.

Use `.env.example` as the reference for local model-provider environment variables. Do not commit populated `.env` files.

## Common Commands

```bash
npm run toolchain:check
npm run clean
npm run check
npm run source:check
npm run build
npm run test:unit
npm run cli:check
npm run smoke:packages
npm run smoke:types
npm run smoke:tarballs
npm run smoke:install
npm run metadata:check
npm run publish:lifecycle:check
npm run audit:check
npm run docs:check
npm run scenario:maintenance:check
npm run ci
```

Use `npm run test:llm` only for manual model smoke testing. It may call a real model and is intentionally not part of the default test suite.

## Change Guidelines

- Keep package exports stable and publishable through `dist`.
- Add local unit tests for runtime, DSL, connector, or patching behavior changes.
- Keep LLM-dependent checks behind explicit manual scripts.
- Do not commit generated `packages/*/dist` artifacts.
- Update README or package metadata when public commands, exports, or setup expectations change.

## Pull Request Checklist

- `npm run ci` passes.
- Relevant docs are updated.
- Source hygiene changes are covered by `npm run source:check`.
- Package export changes are covered by `scripts/verify-package-exports.mjs`.
- Package declaration changes are covered by `scripts/verify-package-types.mjs`.
- Package metadata and tarball changes are covered by `scripts/verify-package-tarballs.mjs`.
- Package installability changes are covered by `scripts/verify-package-install.mjs`.
- Package manifest metadata changes are covered by `scripts/verify-package-metadata.mjs`.
- Workspace publish lifecycle path changes are covered by `scripts/verify-publish-lifecycle.mjs`.
- Dependency vulnerability changes are covered by `npm run audit:check`.
- Documentation link and public API documentation changes are covered by `npm run docs:check`.
- Maintenance scenario wiring or deterministic runtime changes are covered by `scripts/verify-maintenance-scenario.ts`.
- LLM or scenario behavior changes explain whether `npm run test:llm` or `npm run scenario:maintenance` was run.

## Releases

Release preparation is documented in `RELEASING.md`. Do not publish packages until a repository `LICENSE` file exists and package metadata reflects the selected license.

## Licensing

This repository does not yet include a `LICENSE` file. Before public release, maintainers must choose and add an explicit open-source license.
