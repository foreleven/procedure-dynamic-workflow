# API Reference

This document describes the public package surface exposed from `@pac/workflow` and `@pac/engine`.

The project is pre-1.0. APIs listed here are intended to be the supported surface, but maintainers may still make breaking changes before a stable `1.0.0` release.

## `@pac/workflow`

Use this package to define workflow artifacts and connector contracts.

### Public Surface Index

Runtime exports:
- `AckOptionSchema`, `AckRequestSchema`, `ConnectorRegistry`, `DEFAULT_ROUTING_THRESHOLDS`, `JsonRecordSchema`, `PrefetchStore`, `SessionPatchSchema`, `ToolMessage`, `WorkflowContextStore`, `createConnectorRegistry`, `defineConnectorCatalog`, `defineConnectorRef`, `defineConnectorTool`, `definePatch`, `defineRouting`, `defineWorkflowDefinition`, `defineWorkflowHooks`, `effectAction`, `hydrateContextAction`, `loadWorkflowMetadata`, `prefetchAction`, `renderAction`, `resolveAckSelection`, `setContextAction`, `setStateAction`, `settlePrefetch`, `workflow`, `workflowActions`, and `z`.

Public types:
- `AckRequest`, `AckSelection`, `ConnectorCatalog`, `ConnectorInput`, `ConnectorOutput`, `PatchPolicy`, `RenderPolicy`, `RenderResponse`, `RoutingProfile`, `SessionContext`, `ToolMessageInput`, `WorkflowContext`, `WorkflowDefinition`, `WorkflowMetadata`, `WorkflowNode`, `WorkflowPatch`, `WorkflowProgram`, `WorkflowRuntimeInput`, `WorkflowStatePatch`, and `WorkflowToolMessage`.

### Workflow Definition

#### `workflow(config)`

Builds a workflow definition through a program-style DSL.

Input:
- `id`, `version`, `description`: stable workflow identity and metadata.
- `routing`: a `RoutingProfile` from `defineRouting(...)`.
- `stateSchema`: Zod schema for workflow state.
- `state`: default workflow state.
- `invalidation`: optional dependent-state reset rules.

Output:
- a `WorkflowProgram` with `patch(...)`, `prefetch(...)`, `derive(...)`, `command(...)`, and `render(...)`.

Behavior:
- asserts non-empty workflow metadata and invalidation invariants during definition;
- asserts non-empty node names, progress text, and descriptions during registration;
- `patch(...)` must be called exactly once before `render(...)`;
- duplicate node names are rejected;
- asserts render policy metadata before producing a workflow definition.

Boundary:
- this helper trusts TypeScript for typed config shape; `@pac/engine` owns scheduling and execution.

#### `new ToolMessage(input)`

Creates a runtime tool-message entry for connector results or derived facts that should be visible to patch/render LLM calls.

Input:
- `name`: stable tool or connector name.
- `call`: optional tool-call arguments.
- `result`: required tool result payload.
- `id`: optional stable tool-call id.
- `isError`: optional error flag.

Behavior:
- validates the message name, optional id, required result field, and optional error flag;
- serializes to the workflow `role: "tool"` message shape.

Boundary:
- workflow code returns `ToolMessage` instances through `messages` from `derive(...)` or `command(...)`;
- `@pac/engine` converts each workflow tool message into paired PI assistant tool-call and tool-result messages.

#### `defineWorkflowDefinition(definition)`

Returns a `WorkflowDefinition` after checking runtime-only invariants and preserving its generic type information.

Use this when building workflow artifacts without the program DSL.

Behavior:
- trusts the typed workflow definition shape;
- asserts non-empty metadata, routing terms, finite routing thresholds, schema-valid default state, patch policy metadata, invalidation config, node metadata, and render policy metadata during definition;
- rejects default workflow state that defines reserved runtime fields such as `messages`;
- rejects direct definitions with no nodes;
- rejects duplicate node names;
- accepts either a render function or a render policy with non-empty `name`, `instruction`, and `progress`.

Boundary:
- this helper checks typed definition invariants; unknown/dynamic artifact shape checks belong at loading boundaries.

#### `defineWorkflowHooks(config)`

Builds a workflow definition through the legacy hook-style DSL.

Behavior:
- rejects blank node names, invalid node stages, non-function `when` callbacks, and blank progress/description text during definition;
- rejects duplicate render registration;
- requires exactly one render registration.

### Routing and Patch Policies

#### `defineRouting(routing)`

Normalizes routing examples, entities, neighbors, and thresholds.

Default thresholds are exported as `DEFAULT_ROUTING_THRESHOLDS`. Custom thresholds must use known threshold names and finite numbers from `0` to `1`.

#### `definePatch(config)`

Builds an LLM structured extraction policy for session and workflow state patches.

Input:
- `state`: Zod raw shape for patchable workflow state fields.
- `model`: optional model override.
- `progress`: optional user-visible progress text.
- `instruction`: optional extraction instruction.

Output:
- a `PatchPolicy` with a Zod schema that accepts nullable/optional state patch fields.

Behavior:
- rejects malformed state patch shapes;
- rejects reserved runtime state fields such as `messages`.
- rejects malformed optional prompt metadata, including blank `model`, `progress`, or `instruction` strings.

Boundary:
- definition-time config checks are backed by Zod schemas plus reserved-field invariants.

### Connector Contracts

#### `defineConnectorRef(config)`

Creates a typed connector contract with:
- `id`
- optional `description`
- `inputSchema`
- `outputSchema`

Behavior:
- rejects malformed connector ids, blank descriptions, or schema objects during definition.

Boundary:
- connector contract checks are backed by Zod schemas; connector input/output payloads remain owned by each declared schema.

#### `defineConnectorTool(ref, execute)`

Pairs a connector contract with an implementation.

Behavior:
- rejects malformed connector refs or non-function implementations during definition.

Boundary:
- implementations may perform external work;
- inputs and outputs are validated by `ConnectorRegistry.call(...)`.

#### `defineConnectorCatalog(catalog)`

Validates that every object key matches its connector id.

Behavior:
- rejects malformed catalog objects and malformed catalog entries.

#### `createConnectorRegistry(tools, catalog?)`

Creates a schema-validating connector registry.

Behavior:
- rejects non-array tool lists and malformed catalog objects;
- rejects duplicate tool ids;
- rejects malformed connector ids, schema objects, or execute functions during construction;
- rejects catalog keys that do not match connector ids;
- rejects catalog entries without implementations;
- parses inputs before execution;
- parses outputs after execution.

### Runtime Context

#### `PrefetchStore` and `settlePrefetch(tasks)`

`PrefetchStore` holds read-only baseline values loaded before and during workflow turns.

Behavior:
- rejects blank prefetch keys;
- `set(...)`, `merge(...)`, and `settlePrefetch(...)` ignore `undefined` values;
- `merge(...)` and `settlePrefetch(...)` reject malformed task/value collections;
- `settlePrefetch(...)` resolves independent tasks concurrently and drops rejected task results so one failed prefetch does not fail the whole prefetch step.

#### `WorkflowContextStore`

In-memory per-workflow context used during execution.

Use it for runtime coordination, ack requests, memoized values, and connector calls.

Boundary:
- values are not schema validated;
- values are not cloned;
- values are not persisted;
- JSON-native values are compared structurally for change tracking, so object key ordering alone does not advance the revision;
- non-serializable replacements are treated as changed instead of crashing change tracking;
- workflows should keep business state in schema-validated workflow state instead.

### Workflow Actions

#### `workflowActions()` and action helpers

Build reusable workflow callbacks for prefetch, context hydration, state updates, effects, and render cases.

Behavior:
- rejects malformed helper configuration, including non-function callbacks, blank state/context keys, blank context hydration keys, and invalid render cases;
- rejects non-string or blank dynamic render text before returning a render response;
- preserves fallback-only render actions by allowing an empty render case list when a fallback is provided.

### Acknowledgements

#### `resolveAckSelection(request, message)`

Resolves short user replies against an `AckRequest`.

Behavior:
- supports ordinal replies such as `1`, `第一个`, and `第二个`;
- supports exact and partial label/id matches;
- accepts positive confirmation only when there is exactly one option.

## `@pac/engine`

Use this package to execute workflow artifacts.

### Public Surface Index

Runtime exports:
- `WorkflowEngine` and `createLlmClient`.

Public types:
- `CreateSessionInput`, `EngineDeps`, `EngineSession`, `EngineTraceEvent`, `EngineTurnResult`, `LlmClient`, `LlmClientOptions`, `LlmStructuredRequest`, `LlmTextRequest`, `LlmTextStreamEvent`, `LlmUsage`, `WorkflowDefinitionInput`, `WorkflowEngineOptions`, and `WorkflowSnapshot`.

### Engine

#### `new WorkflowEngine(options)`

Creates a runtime engine.

Input:
- `workflows`: workflow definitions to register.
- `deps.llm`: an `LlmClient`.
- `deps.connectors`: a connector registry.
- `deps.now`: optional clock override.
- `maxProgramRounds`: maximum stabilizing rounds for after-patch nodes.
- `logger`: optional engine/LLM log sink.
- `onResponseDelta`: optional stream delta callback.

Behavior:
- trusts typed engine options and workflow definitions produced by `@pac/workflow`;
- keeps unknown workflow artifact shape checks at dynamic loading boundaries;
- rejects invalid engine invariants such as non-positive `maxProgramRounds`;
- validates and stores cloneable state-schema parsed workflow default state during construction;
- rejects raw or parsed workflow default states that define reserved runtime fields such as `messages`;
- rejects duplicate workflow ids during construction;
- serializes logger diagnostics defensively so non-serializable runtime values do not crash execution;
- routes new sessions by local routing metadata;
- keeps active sessions on active workflows;
- appends runtime message history and converts workflow tool messages into paired PI assistant tool-call and tool-result messages;
- extracts structured patches through `deps.llm.structured(...)`;
- reserves the workflow state field `messages` for runtime history and ignores attempts to write it through state patches;
- compares JSON-native state and prefetch values structurally so object key ordering alone does not create dirty fields;
- runs prefetch and effect nodes by stage;
- validates raw prefetch node results before merging them into the runtime prefetch store;
- invalidates dependent fields after state changes, resetting them to default values or deleting fields that are absent from the workflow default state;
- preserves dependent fields explicitly extracted from the latest user message when later same-turn workflow nodes derive source fields that would otherwise invalidate them;
- renders responses through either a workflow render function or an LLM render policy.
- validates workflow render responses and LLM render stream events before recording assistant messages.
- when `onResponseDelta` is configured, emits streamed render deltas sequentially by workflow response order so multiple active workflows cannot interleave user-visible output.

#### `engine.createSession(input)`

Creates an `EngineSession`.

Input:
- `sessionId`
- `userId`
- optional active workflow ids
- optional facts, preferences, goals, and constraints

Behavior:
- trusts typed session input before creating runtime state;
- rejects duplicate or unknown active workflow ids.

#### `engine.onMessage(message, session)`

Runs one user turn.

Behavior:
- validates the message before mutating runtime state;
- rejects duplicate or unknown active workflow ids on the mutable session.

Output:
- `response`: primary render response;
- `responses`: per-workflow render responses;
- `session`: mutated session reference;
- `traces`: runtime trace events for routing, patching, nodes, invalidation, messages, and rendering.

#### `engine.getWorkflowSnapshot(session, workflowId)`

Returns a read-only workflow snapshot for inspection.

### LLM Client

#### `createLlmClient(options?)`

Creates the default pi-ai-backed LLM client.

Input:
- `apiKey`: optional provider API key.
- `baseURL`: optional OpenAI-compatible base URL.
- `defaultModel`: optional default model id.
- `model`: optional fully constructed pi-ai model.
- `logger`: optional log sink.

Boundary:
- no options preserves the historical local default model wiring;
- explicit API key, base URL, or default model opts into OpenAI-compatible model construction;
- construction options are validated by boundary schemas before model wiring, including non-empty credentials/model ids, absolute base URLs, logger functions, and OpenAI-compatible model shape;
- `text`, `streamText`, and `structured` validate request shape through boundary schemas before provider calls, including instruction text, optional model overrides, pi-ai message structure, structured result names, and JSON-schema-compatible Zod schemas;
- local unit tests should use fake `LlmClient` implementations instead of calling real providers.

### Types

Important public types include:
- `LlmClient`
- `LlmClientOptions`
- `LlmTextRequest`
- `LlmStructuredRequest`
- `LlmTextStreamEvent`
- `LlmUsage`
- `EngineSession`
- `EngineTraceEvent`
- `EngineTurnResult`
- `CreateSessionInput`
- `EngineDeps`
- `WorkflowEngineOptions`
- `WorkflowDefinitionInput`
- `WorkflowSnapshot`

The package root intentionally does not export internal runtime implementation types such as
`RuntimeWorkflow`, `RuntimeInstance`, or `TargetSelection`.

## Non-Default Surfaces

The repository includes development and scenario files that are not stable public APIs:
- `scenarios/**`
- `pac-dynamic-workflow/**`
- `packages/*/src/**/*.unit.test.ts`
- `packages/engine/src/typebox-tool.manual.ts`

Do not depend on those paths from published packages.
