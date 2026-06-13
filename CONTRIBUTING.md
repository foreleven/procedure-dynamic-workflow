# Contributing

This repository is moving from an experimental workflow runtime toward a maintainable open-source project. Keep changes small, verified, and aligned with the package boundaries.

Current public-release readiness is tracked in `docs/OPEN_SOURCE_READINESS.md`.

Read `CODE_OF_CONDUCT.md` before participating in public project spaces, and use `SUPPORT.md` to choose the right support channel.

## Local Setup

```bash
npm ci
npm run ci
```

`npm run ci` is the default local quality gate. It type-checks source files, builds both packages, runs local unit tests, and checks high-severity dependency audit findings.

Use Node.js `>=24.0.0` and `npm@11.12.1`; the root package metadata and CI are pinned to that toolchain.

Use `.env.example` as the reference for local model-provider environment variables. Do not commit populated `.env` files.

## Common Commands

```bash
npm run clean
npm run check
npm run build
npm run test:unit
npm test
npm run pack:check
npm run audit:check
npm run scenario:maintenance
npm run test:llm
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
- Package tarball changes are inspected with `npm run pack:check`.
- Relevant docs are updated.
- Dependency vulnerability changes are covered by `npm run audit:check`.
- LLM or scenario behavior changes explain whether `npm run test:llm` or `npm run scenario:maintenance` was run.

## Releases

Release preparation is documented in `RELEASING.md`. Do not publish packages until a repository `LICENSE` file exists and package metadata reflects the selected license.

## Licensing

This repository does not yet include a `LICENSE` file. Before public release, maintainers must choose and add an explicit open-source license.
