---
name: pac-dynamic-workflow
description: Compile natural-language PAC business procedures into executable Dynamic Workflow Runtime TypeScript workflows. Use when the user provides procedure/process text and asks to generate or update a distributable dynamic workflow .ts file using workflow.yaml metadata, Zod schemas, the workflow() program DSL, patch extraction, prefetch/derive/command steps, invalidation, and render.
---

# PAC Dynamic Workflow

## Overview

Use this skill to turn a business procedure into a PAC Dynamic Workflow definition: a `workflow.yaml` metadata file plus one distributable TypeScript workflow file built with the `workflow()` program DSL and exported through `render(...)`.

The workflow is a compiled business artifact, not a runtime plan or graph DSL. Keep runtime-facing structure stable and put workflow-owned business schemas, decisions, nodes, and render instructions inside the workflow file so the generated artifact can be copied or distributed as one business unit.

## Workflow

1. Read `references/pac-workflow-rules.md` before compiling.
2. Inspect the target project for existing runtime APIs:
   - Search for `workflow<`, `prefetch(`, `WorkflowDefinition`, `WorkflowNode`, or existing `*.workflow.ts` files.
   - Reuse existing import paths, type names, helper functions, and formatting when found.
   - If the project has no runtime files yet, generate a self-contained workflow definition with a clearly editable `workflow` import.
3. Convert the user's procedure text into a normalized workflow spec:
   - `id`, `version`, `description`
   - `routing.examples`, `routing.entities`, `routing.neighbors`, `routing.thresholds`
   - `state` fields for mutable business state
   - `prefetch` steps for baseline read-only data needed by patch, plus `derive` steps for state-dependent connector reads and business decisions
   - Zod `stateSchema` and `patch.schema`
   - `invalidation` dependency map
   - cohesive `derive` and `command` steps grouped by business phase
   - render name, progress, and instruction
   - external data/tool dependencies referenced as `{@connectors.xxx}` markers
4. Generate the workflow files.
   - Write `workflow.yaml` for metadata: `id`, `version`, `description`, and `routing`.
   - Write one self-contained `.workflow.ts` definition and load metadata with `loadWorkflowMetadata(import.meta.url)`.
   - Prefer `@pac/workflow` helpers: `workflow` and string-based connector calls.
   - Create the program with `const { patch, prefetch, derive, command, render } = workflow<State, ConnectorCatalog>({...metadata, stateSchema, state})`.
   - Declare `patch(...)`, then `prefetch(...)`, `derive(...)`, `command(...)`, and finally `export default render({ name, progress, instruction })`.
   - Make the step list read like the business procedure. Use `prefetch` for baseline patch-time context, `derive` for deterministic business state derivation and state-dependent connector calls, and `command` for irreversible or externally mutating actions.
   - Do not merely collapse fields into one generic function. Name each step after the business decision it makes and keep that function's inputs, outputs, and side-effect boundary clear.
   - Do not generate `requires` or `writes`. Each `prefetch`, `derive`, and `command` step must decide whether to run in `when(state, context, runtime)` by checking state, `runtime.preState`, and context/messages directly.
   - Each `prefetch`, `derive`, and `command` step must include `progress` and `description`. `progress` is short user-visible status text emitted when `when` matches and the node is selected. `description` explains the business purpose, inputs, outputs, and side-effect boundary for future model/code edits.
   - Write step callbacks as `when(state, context, runtime)` and `run(state, context, runtime)`. Use the first two parameters for the common path; use `runtime` only for session, message, preState, and turn metadata.
   - Do not use or generate `ProgramInput`. Connector calls must go through `context.call("connectors.xxx", input)`. `prefetch` results are automatically written into runtime context and appended as tool messages. State-dependent connector results should usually be returned from `derive` or `command` as `messages: [new ToolMessage({ name, call, result })]` instead of stored as durable business state.
   - Inline one-off `run` implementations inside the corresponding `prefetch`, `derive`, or `command` declaration. Do not create separate `loadX`, `resolveX`, `prepareX`, or `commitX` functions unless the logic is genuinely reused or represents a named pure domain rule.
   - Use patch fields only for facts the latest user message directly expresses. For contextual choices, extract unresolved phrases such as `vehicleRequest` or `dealerRequest`, then resolve them against values read from `context.get(...)` in a structured LLM node.
   - Do not split workflow-owned schemas/defaults, pure logic, node callbacks, or render instructions into extra workflow-local modules. Keep them in the `.workflow.ts` file, organized by sections and helper functions.
   - Put connector refs/catalogs, connector implementations, mock data, and irreversible side-effect boundaries in connector/host modules. Put workflow-owned state schemas and pure selection helpers in the workflow file, not in the connector module.
   - Do not generate `contextSchema`, initial `context`, or `context.*` paths. Runtime `context` is an in-memory KV store with `get/set/delete/clear/call`, scoped to the current engine session, and may hold non-serializable temporary objects. Business facts that must survive turns belong in `state`; connector read results should be accessed through `context.get(...)`.
   - Do not import concrete external service implementations or connector schemas into the workflow definition. If the procedure mentions `{@connectors.xxx}`, generate or reuse a connector ref with Zod input/output schemas in a companion module, inspect those schemas while generating, import only the connector catalog type into the workflow, and call it through `context.call("connectors.xxx", input)` inside step callbacks.
   - External connector implementations live in host/application modules and are injected into `WorkflowEngine` through `deps.connectors`.
   - Do not generate LLM clients or call `deps.llm` inside the workflow definition. Patch and render are executed by the runtime's default LLM path; workflow code only supplies instructions and schemas.
   - Avoid stiff hard-coded user replies. Runtime `RenderResponse` only contains user-visible text; do not generate `type`, `kind`, `decision`, or response-status labels for runtime. Business lifecycle should be represented by business state such as `draft`, `booking`, `confirmed`, or `cancelled`.
   - For render LLM input, rely on the runtime-provided latest `state.messages` message log. The workflow state schema and initial state must not define `messages`; the runtime adds it automatically. Do not build a JSON render payload from state/context.
   - Do not force an intermediate JSON format unless the user explicitly asks for one.

5. Validate the generated workflow:
   - Top-level runtime shape must resolve to `id`, `version`, `description`, `routing`, `stateSchema`, `state`, `nodes`, `patch`, `invalidation`, and `render`.
   - Include workflow-owned Zod schemas for state and patch extraction.
   - Every connector dependency must have a Zod input schema and Zod output schema.
   - Workflow files must call connector dependencies through `context.call("connectors.xxx", input)` inside `prefetch`, `derive`, and `command` callbacks, not direct imported service functions or connector ref objects.
   - Workflow files must not call LLM helpers directly; patch/render instructions are declarations consumed by the runtime.
   - Patch LLM instructions must forbid chain-of-thought, long planning, and final responses. Business connector calls must happen in `prefetch`, `derive`, or `command` steps, not inside patch extraction.
   - Workflow code must not use local regex classifiers to decide user intent or repair LLM patch output. Model unresolved user references as state and resolve them through nodes.
   - `derive` and `command` steps must return partial state directly, such as `{ draft, status }`, not `{ state: { draft, status } }`. If a step needs runtime scratch data, it may call `context.set(...)`, but that data must not become business truth.
   - `command` steps must be guarded by explicit state evidence such as confirmation and should not run from ambiguous user text alone.
   - User-visible text must come only from `render`, and `render` must return `{ text }`.
   - State changes must invalidate dependent fields instead of restarting the workflow.
   - Irreversible completion must be represented by a committed state field produced by an effect node, not by a bare confirmation flag.

## Output Guidelines

Prefer one metadata file plus one workflow definition file per workflow, named `workflow.yaml` and from the workflow id such as `maintenance_booking.workflow.ts`. The `.workflow.ts` file is the skill-generated distribution artifact; a consumer should not need additional workflow-local TypeScript modules to run it.

When the procedure is underspecified, make conservative assumptions and leave short integration notes only where a real business API, data model, or policy is unknown. Do not invent irreversible side effects such as payment capture, booking confirmation, or cancellation without an explicit confirmation state.

## Resources

- `references/pac-workflow-rules.md`: PAC workflow definition rules, compilation checklist, and TypeScript generation guidance.
