# @pac/engine

Runtime engine for executing PAC dynamic workflow artifacts.

## Install

Requires Node.js `>=24.0.0`.

```bash
npm install @pac/engine @pac/workflow
```

## Usage

```ts
import { createConnectorRegistry } from "@pac/workflow";
import { WorkflowEngine, createLlmClient } from "@pac/engine";
import workflow from "./workflow.js";

const engine = new WorkflowEngine({
  workflows: [workflow],
  deps: {
    connectors: createConnectorRegistry(),
    llm: createLlmClient({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      defaultModel: process.env.OPENAI_MODEL,
    }),
  },
});

const session = engine.createSession({
  sessionId: "session_1",
  userId: "user_1",
});

const result = await engine.invoke("start the workflow", session);
console.log(result.messages.find((message) => message.role === "assistant")?.content ?? "");
```

## Public Surface

- `WorkflowEngine` routes messages through a structured workflow-level route gate, extracts structured patches, runs workflow nodes, and renders responses.
- `engine.invoke(...)` and `engine.stream(...)` accept either a non-empty string or a `WorkflowUserMessage`; string inputs are timestamped at the engine boundary.
- One engine can register multiple workflows; selected workflow instances run independent full pipelines in the same turn before the engine emits merged or separate assistant messages.
- `EngineSession.messages` is the engine-level transcript. Each workflow instance keeps workflow-local `messages` for its own patch/render context; the engine commits the final user-visible output back to the session.
- Engine turns commit in-memory session routing, workflow runtime state, dependency-gated effect memory, and final messages only after successful completion; failed turns roll those runtime mutations back before returning the error.
- Multiple independently rendered LLM workflow responses are merged into one natural engine response by default. `WorkflowEngineOptions.render.mergeStrategy` receives a session snapshot and can return `separate` so workflow outputs are emitted individually as they complete.
- `engine.stream(...)` runs the same turn pipeline as `engine.invoke(...)` and exposes assistant deltas, workflow step events, trace events, assistant output messages, and turn completion through an async iterable.
- `WorkflowRouter`, `RouteGate`, `WorkflowCandidateProvider`, `AllWorkflowCandidateProvider`, and `FlashLlmRouteGate` describe the routing extension points used by `WorkflowEngineOptions.routing`; router output is validated before the engine applies session lifecycle changes.
- `createLlmClient(...)` creates an OpenAI-compatible LLM client through `@earendil-works/pi-ai`.
- `LlmClient`, `LlmClientOptions`, and LLM request/event types describe model adapter boundaries.
- `EngineSession`, `EngineUserMessageInput`, `EngineInvokeResult`, `EngineTraceEvent`, event payload types, and engine option/input types describe runtime state and execution traces.

See the repository [API reference](https://github.com/foreleven/procedure-dynamic-workflow/blob/main/docs/API.md) for the full public API reference.

## Repository Development

Development CLI commands, local test commands, and manual LLM smoke tests live in the repository workspace, not in this published package entry point. See the [root README](https://github.com/foreleven/procedure-dynamic-workflow#readme) for contributor workflows.

Implementation ownership, class dependencies, turn sequencing, and reviewed source-file boundaries are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Status

This package is pre-1.0. Public APIs may change while the project is moving toward a stable open-source release.

## License

No open-source license has been selected yet. Do not treat this package as formally released until the repository includes an explicit `LICENSE` file.
