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

`state.messages` is the workflow conversation log. User turns, simulated tool calls/results, and rendered assistant replies are appended by the runtime or workflow steps so patch/render can use the latest conversation context.

## Install

```bash
npm install
```

Set OpenAI-compatible credentials in `.env` or the shell:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_BASE_URL=... # optional
```

## Commands

Type-check the workspace:

```bash
npm run check
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
- irreversible external actions belong in `command`;
- read-only or idempotent state-dependent work belongs in `derive`;
- baseline reads belong in `prefetch`.

Avoid local text classifiers for user intent. Let patch extract structured state from the conversation, and let workflow steps resolve business state against connector data.

## Status

This is an experimental runtime and scenario workspace, not a packaged production service.
