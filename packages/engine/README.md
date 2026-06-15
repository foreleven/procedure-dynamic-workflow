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

const result = await engine.onMessage("start the workflow", session);
console.log(result.response.text);
```

## Public Surface

- `WorkflowEngine` routes messages through a structured workflow-level route gate, extracts structured patches, runs workflow nodes, and renders responses.
- One engine can register multiple workflows; selected workflows run in the same turn and are returned through `EngineTurnResult.responses`.
- Multiple LLM render policies are merged into one natural assistant response by default; `WorkflowEngineOptions.render.mergeStrategy` can return `separate` to keep per-workflow render calls.
- `WorkflowRouter`, `RouteGate`, `WorkflowCandidateProvider`, `AllWorkflowCandidateProvider`, and `FlashLlmRouteGate` describe the routing extension points used by `WorkflowEngineOptions.routing`.
- `createLlmClient(...)` creates an OpenAI-compatible LLM client through `@earendil-works/pi-ai`.
- `LlmClient`, `LlmClientOptions`, and LLM request/event types describe model adapter boundaries.
- `EngineSession`, `EngineTraceEvent`, `EngineTurnResult`, and engine option/input types describe runtime state and execution traces.

See the repository [API reference](https://github.com/foreleven/procedure-dynamic-workflow/blob/main/docs/API.md) for the full public API reference.

## Repository Development

Development CLI commands, local test commands, and manual LLM smoke tests live in the repository workspace, not in this published package entry point. See the [root README](https://github.com/foreleven/procedure-dynamic-workflow#readme) for contributor workflows.

## Status

This package is pre-1.0. Public APIs may change while the project is moving toward a stable open-source release.

## License

No open-source license has been selected yet. Do not treat this package as formally released until the repository includes an explicit `LICENSE` file.
