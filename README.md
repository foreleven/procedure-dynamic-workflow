# procedure-dynamic-workflow

Compile natural-language business procedures into executable dynamic workflows.

This project explores a workflow runtime where a procedure is represented as a small TypeScript artifact:

- `patch` extracts structured state from the latest user turn.
- `prefetch` loads baseline read-only data.
- `derive` computes state-dependent facts and candidate options.
- `command` performs irreversible or externally mutating actions.
- `render` produces the next user-facing reply.

The workflow owns business state and instructions. The runtime owns scheduling, connector injection, progress events, conversation message history, and LLM execution. The engine's `llm.ts` uses `@earendil-works/pi-ai` directly for OpenAI-compatible completion, structured tool calls, and streaming text.

## Repository Layout

```text
packages/
  workflow/      Workflow DSL, connector contracts, schemas, and workflow artifact types.
  engine/        Runtime engine, pi-ai LLM client, CLI, session handling, env wiring, patch application, node execution, and rendering.

scenarios/
  maintenance/  Example vehicle-maintenance booking procedure, workflow artifact, mock connectors, and scenario runner.

pac-dynamic-workflow/
  SKILL.md      Authoring guide for compiling procedures into workflow artifacts.
  references/   Detailed workflow generation rules.
```

## Core Concepts

`workflow.yaml` stores stable metadata such as workflow id, version, routing examples, and scenario cases.

`*.workflow.ts` is the distributable workflow artifact. It defines workflow-owned schemas, initial state, patch policy, invalidation rules, business steps, and render instruction.

`connectors.ts` defines external tool contracts and demo implementations. Workflow code calls connectors through `context.call("connectors.xxx", input)`.

`messages` is a runtime-owned conversation log on each workflow instance. User turns, tool messages, and rendered assistant replies are appended by the runtime or explicit workflow message outputs. Workflow schemas, default state, and state patches must not declare or overwrite the reserved `messages` field.

## API Reference

Public package APIs are documented in `docs/API.md`.

Open-source readiness status is tracked in `docs/OPEN_SOURCE_READINESS.md`.

## Install

```bash
npm ci
```

The local CLI and manual LLM smoke tests read OpenAI-compatible credentials from `.env` or the shell. `.env.example` documents the expected keys:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_BASE_URL=... # optional
```

The verified development toolchain is Node.js `>=24.0.0` with `npm@11.12.1`.

## Commands

Verify the local Node.js and npm versions:

```bash
npm run toolchain:check
```

Type-check the workspace:

```bash
npm run check
```

Check source hygiene and tracked-file hygiene:

```bash
npm run source:check
```

Remove compiled package artifacts:

```bash
npm run clean
```

Build package artifacts:

```bash
npm run build
```

Run the local unit test suite:

```bash
npm test
```

Run the local CLI smoke checks:

```bash
npm run cli:check
```

Verify published package exports:

```bash
npm run smoke:packages
```

Verify published package declaration files from an external TypeScript consumer:

```bash
npm run smoke:types
```

Verify package tarball contents:

```bash
npm run smoke:tarballs
```

Verify package tarball installation from a temporary external project:

```bash
npm run smoke:install
```

Check package metadata:

```bash
npm run metadata:check
```

Check workspace publish lifecycle path safety:

```bash
npm run publish:lifecycle:check
```

Run the high-severity dependency audit:

```bash
npm run audit:check
```

Check documentation links and API coverage:

```bash
npm run docs:check
```

Run the default local verification set:

```bash
npm run ci
```

Run the manual LLM tool-call smoke test:

```bash
npm run test:llm
```

Run the maintenance booking chat demo:

```bash
npm run chat:maintenance
```

Run one or more scripted turns for agent-driven testing:

```bash
npm run chat:maintenance -- --message "我想预约保养" --message "就用默认车辆"
```

Run the maintenance scenario suite:

```bash
npm run scenario:maintenance
```

Run deterministic maintenance scenario wiring and runtime path checks:

```bash
npm run scenario:maintenance:check
```

Run the generic chat CLI with explicit files:

```bash
npm run chat -- \
  --workflow scenarios/maintenance/maintenance_booking.workflow.ts \
  --connectors scenarios/maintenance/connectors.ts \
  --user-id user_feng
```

Add `--debug` to print full engine and LLM logs. Without `--debug`, the CLI only prints workflow progress events, LLM phase durations, and the assistant reply.

Render output streams by default when the configured LLM client supports it. Add `--no-stream` to print only the final reply.

## Maintenance Example

The maintenance scenario compiles `scenarios/maintenance/procedure.md` into:

- `workflow.yaml`: metadata and acceptance cases.
- `maintenance_booking.workflow.ts`: state schema, patch instruction, prefetch/derive/command steps, and render instruction.
- `connectors.ts`: customer, vehicle, dealer, slot, draft, and booking connector implementations.
- `run.ts`: scenario runner with LLM semantic response checks.

The example demonstrates:

- single-vehicle auto-selection;
- multi-vehicle disambiguation;
- dealer selection;
- preferred date extraction;
- slot lookup and slot confirmation;
- booking draft creation;
- explicit confirmation before final booking;
- cancellation before commit;
- service-item questions being deferred to a later procedure.

## Authoring Notes

Keep workflow instructions focused:

- patch instruction only describes how to extract state;
- render instruction only describes how to reply;
- derive and command callbacks return partial state directly, for example `{ bookingDraft, status }`;
- derive and command callbacks return connector facts for render as `messages: [new ToolMessage({ name, call, result })]`;
- irreversible external actions belong in `command`;
- read-only or idempotent state-dependent work belongs in `derive`;
- baseline reads belong in `prefetch`.

Avoid local text classifiers for user intent. Let patch extract structured state from the conversation, and let workflow steps resolve business state against connector data.

## Contributing

Read `CONTRIBUTING.md` before opening a change. The default local quality gate is:

```bash
npm run ci
```

Report suspected vulnerabilities through the process in `SECURITY.md`.

Support expectations are documented in `SUPPORT.md`.

Participation expectations are documented in `CODE_OF_CONDUCT.md`.

Read `RELEASING.md` for versioning and package publishing steps.

## Licensing

This repository does not yet include a `LICENSE` file. It should not be treated as a formally released open-source project until maintainers choose and add an explicit license.

Package publish attempts are guarded by `prepublishOnly` checks and will fail until a repository `LICENSE` exists and published package manifests declare the selected license.

## Status

This is an experimental runtime and scenario workspace, not a packaged production service.
