# API Reference

This document describes the public package surface exposed from `@pac/workflow` and `@pac/engine`.

The project is pre-1.0. APIs listed here are intended to be the supported surface, but maintainers may still make breaking changes before a stable `1.0.0` release.

## `@pac/workflow`

Use this package to define workflow artifacts and connector contracts.

### Public Surface Index

Runtime exports:
- `AckOptionSchema`, `AckRequestSchema`, `ConnectorRegistry`, `DEFAULT_ROUTING_THRESHOLDS`, `JsonRecordSchema`, `PrefetchStore`, `SessionPatchSchema`, `ToolMessage`, `WorkflowContextStore`, `createConnectorRegistry`, `defineConnectorCatalog`, `defineConnectorRef`, `defineConnectorTool`, `definePatch`, `defineRouting`, `defineWorkflowDefinition`, `defineWorkflowDefinitionFromTemplate`, `defineWorkflowHooks`, `defineWorkflowTemplate`, `effectAction`, `hydrateContextAction`, `loadWorkflowMetadata`, `prefetchAction`, `renderAction`, `resolveAckSelection`, `setContextAction`, `setStateAction`, `settlePrefetch`, `workflow`, `workflowActions`, and `z`.

Public types:
- `AckRequest`, `AckSelection`, `ConnectorCatalog`, `ConnectorInput`, `ConnectorOutput`, `PatchPolicy`, `PrefetchStoreCheckpoint`, `ProgramLoop`, `ProgramLoopConfig`, `ProgramLoopEffectConfig`, `ProgramWorkflowBaseConfig`, `ProgramWorkflowConfig`, `ProgramWorkflowTemplateConfig`, `RenderPolicy`, `RenderResponse`, `RoutingProfile`, `SessionContext`, `ToolMessageInput`, `WorkflowAssistantMessage`, `WorkflowContext`, `WorkflowContextCallOptions`, `WorkflowContextStoreCheckpoint`, `WorkflowDefinition`, `WorkflowDefinitionBody`, `WorkflowDefinitionMetadata`, `WorkflowDefinitionTemplate`, `WorkflowLoopNode`, `WorkflowLoopRuntime`, `WorkflowMessage`, `WorkflowMetadata`, `WorkflowNode`, `WorkflowPatch`, `WorkflowProgram`, `WorkflowRuntimeInput`, `WorkflowStatePatch`, `WorkflowStepController`, `WorkflowStepHandle`, `WorkflowTemplateProgram`, `WorkflowToolMessage`, and `WorkflowUserMessage`.

### Workflow Definition

#### `workflow(config)`

Builds a workflow through a program-style DSL.

Input:
- `stateSchema`: Zod schema for workflow state.
- `state`: default workflow state.
- `invalidation`: optional dependent-state reset rules.
- Optional `id`, `version`, `description`, and `routing` for standalone modules that export complete workflow definitions.

Output:
- a `WorkflowProgram` or `WorkflowTemplateProgram` with `patch(...)`, `prefetch(...)`, `effect(...)`, `loop(...)`, `command(...)`, and `render(...)`.
- If metadata is omitted, `render(...)` returns a `WorkflowDefinitionTemplate`; agent-directory CLI loading attaches `agent.yaml` metadata before runtime execution.
- If metadata is supplied, `render(...)` returns a complete `WorkflowDefinition`.
- In agent-directory loading, manifest metadata is the source of truth and overrides metadata from legacy complete definitions.
- `derive(...)` remains available as a migration alias for `effect(...)`.

Behavior:
- asserts non-empty workflow metadata when supplied and invalidation invariants during definition;
- rejects author `TState`/default state shapes that declare the runtime-owned `messages` field;
- asserts non-empty node names and descriptions during registration, and validates required prefetch progress text;
- `effect(name, dependsOn, config)` and `config.dependsOn` gate an effect by state-field or completed-loop dependency snapshots;
- `patch(...)` must be called exactly once before `render(...)`;
- duplicate node names are rejected;
- asserts render policy metadata before producing a workflow definition.

Boundary:
- this helper trusts TypeScript for typed config shape; `@pac/engine` owns manifest metadata injection, scheduling, and execution.

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
- workflow code returns `ToolMessage` instances through `messages` from `effect(...)` or `command(...)`;
- `@pac/engine` converts each workflow tool message into plain runtime fact text for patch/render prompts, not provider-native tool-call transcripts.

#### Effect dependencies and steps

Use `effect(...)` for deterministic, idempotent state progression after patch.

Input:
- `dependsOn`: optional state field list, either as `effect(name, dependsOn, config)` or `config.dependsOn`.
- `run`: callback that can return partial state and `messages`.

Behavior:
- effect configs do not declare `when`; business guards belong at the start of `run`;
- effect configs do not expose `progress`; use `step.start(...)` and `step.end(...)` for loading UI;
- workflow callbacks do not receive a separate `preState` or latest-message string; use `state.messages` for workflow-local transcript context;
- when `dependsOn` is omitted, the effect runs during each stabilization round until it produces no semantic change;
- when `dependsOn` is provided, the runtime compares the current dependency values to the last successful run for that node and skips unchanged snapshots during stabilization;
- `dependsOn: []` runs once for the workflow instance;
- the `run` callback receives `runtime.step` and a fourth `step` argument, both implementing `WorkflowStepController`;
- `const loading = step.start("label"); ...; loading.end();` emits `node.step.start` and `node.step.end` trace events without mutating workflow state;
- `const child = loading.child("child label"); ...; child.end();` emits child lifecycle events with `parentStepId` pointing at the parent step;
- multiple step handles can be open at the same time, so workflow code can wrap parallel connector calls with independent loading steps.
- ending a parent step closes any still-open descendants first, so stream consumers receive a complete child-to-parent completion order.

Boundary:
- dependency fields are workflow state keys, not context or prefetch keys;
- `messages` is reserved and cannot be used as a dependency field;
- step labels are user-visible loading text, while optional step details are diagnostics.

#### Loop nodes

Use `loop(name, config)` for bounded multi-pass workflow execution inside one engine turn.

Input:
- `dependsOn`: optional workflow state fields or prior completed loops such as `loop.discovery`.
- `maxRuns`: required integer from `1` to `5`.
- `stateSchema`: Zod schema for the model-produced state for one loop run.
- `instruction`: planner instruction for deciding `continue`, `satisfied`, or `blocked`.

Behavior:
- the engine calls the LLM once per run to produce `{ status, reason, state }`;
- `continue` requires schema-valid loop `state`; `satisfied` and `blocked` require `state: null`;
- loop effects are registered with `loop.effect(name, ["loop.state"], config)` and receive `runtime.loop.state`;
- loop effects can return partial workflow state and `messages`, using the same patch boundary as ordinary effects;
- `dependsOn: ["loop.someLoop"]` on a later effect or loop waits until `someLoop` has stopped.

Boundary:
- loop runtime state is engine-owned and not part of workflow `stateSchema`;
- put raw evidence in `ToolMessage`s, not workflow state;
- use workflow state patches only for compact durable handoff facts.

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

#### `defineWorkflowTemplate(body)`

Returns a `WorkflowDefinitionTemplate` after checking workflow-owned state, patch, invalidation, node, and render invariants. Templates intentionally omit stable metadata and cannot be executed by the engine until materialized.

#### `defineWorkflowDefinitionFromTemplate(metadata, template)`

Attaches `WorkflowDefinitionMetadata` from an agent manifest to a `WorkflowDefinitionTemplate` and returns a complete `WorkflowDefinition`.

Boundary:
- manifest metadata is validated at the CLI/definition boundary before the workflow enters the engine.

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
- `checkpoint()` and `restore(checkpoint)` support same-process engine turn rollback while preserving runtime value identities.

#### `WorkflowContextStore`

In-memory per-workflow context used during execution.

Use it for runtime coordination, ack requests, memoized values, and connector calls.

Boundary:
- values are not schema validated;
- values are not cloned;
- values are not persisted;
- `context.call(id, input, { cache: true })` caches in-flight and successful connector results inside the current workflow context, using `[id, JSON.stringify(input)]` as the default key;
- `context.call(id, input, { cacheKey })` uses a custom stable JSON-native key such as `["connector", userId]`; include every input dependency that affects the result;
- without `cache: true` and without a non-null `cacheKey`, the connector-call cache is bypassed;
- `cache: true` requires `input` to be JSON-serializable unless a custom `cacheKey` is provided;
- rejected connector calls are removed from the cache so later attempts can retry;
- JSON-native values are compared structurally for change tracking, so object key ordering alone does not advance the revision;
- non-serializable replacements are treated as changed instead of crashing change tracking;
- `checkpoint()` and `restore(checkpoint)` support same-process engine turn rollback while preserving runtime value and connector promise identities;
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
- `AllWorkflowCandidateProvider`, `FlashLlmRouteGate`, `RouteGate`, `WorkflowCandidateProvider`, `WorkflowEngine`, `WorkflowRouter`, and `createLlmClient`.

Public types:
- `AssistantMessageEvent`, `CreateSessionInput`, `EngineDeps`, `EngineInvokeResult`, `EngineSession`, `EngineStreamEvent`, `EngineStreamPayload`, `EngineTraceEvent`, `EngineTraceStreamEvent`, `EngineTurnDoneEvent`, `EngineUserMessageInput`, `LlmClient`, `LlmClientOptions`, `LlmStructuredRequest`, `LlmTextRequest`, `LlmTextStreamEvent`, `LlmUsage`, `RoutingAction`, `WorkflowDefinitionInput`, `WorkflowEngineOptions`, `WorkflowRenderMergeDecision`, `WorkflowRenderMergeStrategy`, `WorkflowRenderMergeStrategyInput`, `WorkflowRenderOptions`, `WorkflowRoutingInput`, `WorkflowRoutingOptions`, `WorkflowRoutingResult`, `WorkflowSnapshot`, and `WorkflowStepEvent`.

### Engine

#### `new WorkflowEngine(options)`

Creates a runtime engine.

Input:
- `workflows`: workflow definitions to register.
- `deps.llm`: an `LlmClient`.
- `deps.connectors`: a connector registry.
- `deps.now`: optional clock override for engine-created user-message timestamps, route-gate provider message timestamps, and patch runtime current-time prompts.
- `routing`: optional workflow router, route gate, candidate provider, gate model, confidence, and profile/message limits.
- `render.mergeStrategy`: optional strategy for choosing whether multiple independently rendered LLM workflow responses should merge into one engine response; defaults to merge, receives a session snapshot, and can return `separate`.
- `maxProgramRounds`: maximum stabilizing rounds for after-patch nodes.
- `logger`: optional engine/LLM log sink.

Behavior:
- trusts typed engine options and workflow definitions produced by `@pac/workflow`;
- keeps unknown workflow artifact shape checks at dynamic loading boundaries;
- revalidates workflow metadata, routing thresholds, node metadata, patch policy, and render policy before registering runtime artifacts;
- rejects invalid engine invariants such as non-positive `maxProgramRounds`;
- validates and stores cloneable state-schema parsed workflow default state during construction;
- rejects raw or parsed workflow default states that define reserved runtime fields such as `messages`;
- rejects duplicate workflow ids during construction;
- serializes logger diagnostics defensively so non-serializable runtime values do not crash execution;
- emits `node.step.start` and `node.step.end` traces for workflow-owned loading steps, including `parentStepId` for nested child steps;
- routes new sessions through a structured workflow-level route gate before running any workflow;
- routes existing sessions through protocol fast path or a structured route gate that can continue, switch, run parallel workflows, clarify, or select no workflow;
- keeps short replies that resolve an active workflow acknowledgement on the active workflow without calling the route gate;
- supports custom `WorkflowRouter`, `RouteGate`, and `WorkflowCandidateProvider` implementations through `WorkflowEngineOptions.routing`;
- passes custom routers and `render.mergeStrategy` session snapshots instead of the live engine session, and validates router output before applying any session lifecycle changes;
- keeps `EngineSession.messages` as the engine-level transcript while each workflow instance keeps its own workflow-local `messages` history;
- runs each selected workflow instance through its own `beforePatch -> withPatch -> patch -> afterPatch -> render` pipeline before the engine chooses merged or separate assistant messages;
- commits session routing state, workflow runtime state, dependency-gated effect memory, and final messages only when the turn completes successfully; failed turns roll those in-memory runtime mutations back before the error reaches the caller;
- extracts structured patches through `deps.llm.structured(...)` after the workflow instance has run its own pre-patch nodes;
- reserves the workflow state field `messages` for runtime-provided history snapshots and ignores attempts to write it through state patches;
- compares JSON-native state and prefetch values structurally so object key ordering alone does not create dirty fields;
- runs selected workflow instance pipelines concurrently, with each instance stabilizing its own after-patch nodes;
- validates raw prefetch node results before merging them into the runtime prefetch store;
- invalidates dependent fields after state changes, resetting them to default values or deleting fields that are absent from the workflow default state;
- preserves dependent fields explicitly extracted from the latest user message when later same-turn workflow nodes write source fields that would otherwise invalidate them;
- renders each selected workflow through either its workflow render function or LLM render policy;
- lets the engine merge already-rendered LLM workflow responses into one final engine response by default;
- keeps function-based workflow responses separate because they do not expose mergeable render instructions;
- emits separate workflow assistant messages in workflow completion order; `engine.invoke(...).messages[0]` is the first workflow output that completed for that turn;
- validates workflow render responses and LLM render stream events before committing the engine-level assistant output to the session log;
- `engine.stream(...)` emits assistant text deltas, workflow progress/step lifecycle events, trace events, assistant output messages, and turn completion through one async iterable.

#### `engine.createSession(input)`

Creates an `EngineSession`.

Input:
- `sessionId`
- `userId`
- optional active workflow ids
- optional existing `messages` history, preserving stable ids and metadata; existing user messages should include a finite `timestamp`
- optional facts, preferences, goals, and constraints

Behavior:
- trusts typed session input before creating runtime state;
- rejects duplicate or unknown active workflow ids.

#### `engine.invoke(message, session)`

Runs one user turn and returns an `EngineInvokeResult`.

Input:
- `message`: either a non-empty string or a `WorkflowUserMessage`. String inputs are normalized at the engine boundary into user messages with a timestamp from `deps.now` or the current clock; caller-supplied user-message `id`, `timestamp`, and metadata are preserved.
- `session`: mutable `EngineSession`.

Behavior:
- consumes the same event/message path as `engine.stream(...)`;
- validates the message before mutating runtime state;
- rejects duplicate or unknown active workflow ids on the mutable session.

Output:
- `messages`: committed assistant messages emitted by the engine for this turn;
- `events`: runtime events emitted while executing the turn, including trace and completion events.

#### `engine.stream(message, session)`

Runs one user turn and returns an `AsyncIterable<EngineStreamPayload>`.

Input:
- same `message` and `session` contract as `engine.invoke(...)`.

Behavior:
- shares the same execution path and validation as `engine.invoke(...)`;
- exposes an `AsyncIterable<EngineStreamPayload>` where each payload is either `{ message }` or `{ event }`;
- emits `{ event: AssistantMessageEvent }` for assistant text deltas;
- emits `{ event: WorkflowStepEvent }` for workflow progress, step start, and step end events; nested step start/end events include `parentStepId`;
- emits `{ event: EngineTraceStreamEvent }` for runtime diagnostics that `engine.invoke(...)` returns in `events`;
- emits `{ message }` for assistant output messages as they become available;
- emits `{ event: EngineTurnDoneEvent }` after the turn completes and successful output messages have been committed to the session.
- if the stream later fails before `EngineTurnDoneEvent`, any earlier separate output messages from that turn are provisional and the engine rolls back the turn's session/workflow runtime mutations.

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
- `AssistantMessageEvent`
- `EngineInvokeResult`
- `EngineSession`
- `EngineStreamEvent`
- `EngineStreamPayload`
- `EngineTraceEvent`
- `EngineTraceStreamEvent`
- `EngineTurnDoneEvent`
- `EngineUserMessageInput`
- `WorkflowStepEvent`
- `CreateSessionInput`
- `EngineDeps`
- `WorkflowEngineOptions`
- `WorkflowDefinitionInput`
- `WorkflowSnapshot`

The package root intentionally does not export internal runtime implementation types such as
`RuntimeWorkflow`.

## Non-Default Surfaces

The repository includes development and scenario files that are not stable public APIs:
- `agents/**`
- `pac-dynamic-workflow/**`
- `packages/*/src/**/*.unit.test.ts`
- `packages/engine/src/typebox-tool.manual.ts`

Do not depend on those paths from published packages.
