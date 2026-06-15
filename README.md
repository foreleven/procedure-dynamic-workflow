# procedure-dynamic-workflow

Compile natural-language business procedures into executable dynamic workflows.

This project explores a workflow runtime where a procedure is represented as a small TypeScript artifact:

- `patch` extracts structured state from the latest user turn.
- `prefetch` loads baseline read-only data.
- `effect` computes state-dependent facts and candidate options.
- `command` performs irreversible or externally mutating actions.
- `render` produces the next user-facing reply.

The workflow owns business state and instructions. The runtime owns scheduling, connector injection, progress events, conversation message history, and LLM execution. The engine's `llm/` modules use `@earendil-works/pi-ai` directly for OpenAI-compatible completion, structured tool calls, and streaming text.

## Repository Layout

```text
packages/
  workflow/      Workflow DSL, connector contracts, schemas, and workflow artifact types.
                 Internal code is grouped by definition guards, runtime stores, and shared utilities.
  engine/        Runtime engine, pi-ai LLM client, CLI, session handling, env wiring, patch application, node execution, and rendering.
                 Internal code is grouped by CLI loading, LLM provider wiring, runtime execution, and shared utilities.

agents/
  maintenance/  Example vehicle-maintenance booking procedure, workflow artifact, mock connectors, and agent cases.

pac-dynamic-workflow/
  SKILL.md      Authoring guide for compiling procedures into workflow artifacts.
  references/   Detailed workflow generation rules.
```

## Core Concepts

`agent.yaml` stores stable metadata such as workflow id, version, routing examples, connector file names, and scenario cases. For directory-based CLI runs, each `workflows.<name>` entry maps to `workflows/<name>.workflow.ts`, and each `connectors` entry maps to `connectors/<name>.ts`.

`*.workflow.ts` is the distributable workflow artifact. It defines workflow-owned schemas, initial state, patch policy, invalidation rules, business steps, and render instruction.

`connectors/*.ts` files define external tool contracts and demo implementations. Each connector file default-exports a loader function that returns connector tools; the engine builds the registry after loading all files listed in `agent.yaml`. Workflow code calls connectors through `context.call("connectors.xxx", input)`, with optional per-context caching via `context.call("connectors.xxx", input, { cache: true })`.

`messages` is a runtime-owned conversation log on the engine session. Each selected workflow receives a shallow copy for the current turn, appends its own workflow tool facts, and the engine merges those new facts before render. Rendered assistant replies are committed back to the session log. Patch and routing gate LLM requests are internal calls and are not appended. Workflow schemas, default state, and state patches must not declare or overwrite the reserved `messages` field.

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

Type-check the workspace:

```bash
npm run check
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
npm run test:unit
```

Unit tests may live beside implementation files anywhere under `packages/*/src` as `*.unit.test.ts`.

Run type checking, package builds, and unit tests:

```bash
npm test
```

Inspect package tarballs without publishing:

```bash
npm run pack:check
```

Run the high-severity dependency audit:

```bash
npm run audit:check
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

Run all scripted cases from `agent.yaml`:

```bash
npm run chat -- agents/maintenance --all-cases --no-stream
```

Run the generic chat CLI with explicit files:

```bash
npm run chat -- \
  --workflow agents/maintenance/workflows/maintenance_booking.workflow.ts \
  --connectors agents/maintenance/connectors/main.ts \
  --user-id user_feng
```

Run the same CLI from an agent directory without passing a workflow path; the CLI reads `./agent.yaml`, imports `workflows/<name>.workflow.ts` for each `workflows.<name>` entry, and loads each `connectors/<name>.ts` file listed under `connectors`:

```bash
cd agents/maintenance
npx tsx ../../packages/engine/src/cli.ts --user-id user_feng
```

You can also pass the agent directory explicitly from the repository root:

```bash
npm run chat -- agents/maintenance --user-id user_feng
```

Run scripted turns from a case in `agent.yaml`:

```bash
npm run chat -- agents/maintenance --case time_ack_then_draft_then_confirm --no-stream
```

Add `--debug` to print full engine and LLM logs. Without `--debug`, the CLI only prints routing active workflows, workflow progress events, workflow step start/end loading lines, LLM phase durations, and the assistant reply.

The `--workflow` module may export one workflow or an array named/defaulted as `workflows`. For multi-workflow modules, the CLI starts without a preselected active workflow and lets the structured route gate select the matching workflows for each new session.

Render output streams by default when the configured LLM client supports it. Add `--no-stream` to print only the final reply.

## Maintenance Example

The maintenance agent compiles `agents/maintenance/procedure.md` into:

- `agent.yaml`: metadata, connector file names, workflow names, and acceptance cases.
- `workflows/maintenance_booking.workflow.ts`: state schema, patch instruction, prefetch/effect/command steps, and render instruction.
- `connectors/main.ts`: customer, vehicle, dealer, slot, draft, and booking connector implementations.

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
- effect and command callbacks return partial state directly, for example `{ bookingDraft, status }`;
- effect and command callbacks return connector facts for render as `messages: [new ToolMessage({ name, call, result })]`;
- effect callbacks put business guard logic at the start of `run` and use `step.start(...)` / `step.end(...)` for loading UI;
- irreversible external actions belong in `command`;
- read-only or idempotent state-dependent work belongs in `effect`;
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
