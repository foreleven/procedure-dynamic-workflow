---
name: pac-workflow-creator
description: Compile business procedures into PAC Dynamic Workflow artifacts with workflow.yaml metadata, connector contracts, workflow() program DSL steps, invalidation, and render policy.
---

# PAC Workflow Creator

Use this skill when a user asks to create or update a PAC workflow from a business procedure.

## Inputs

- A natural-language procedure or process description.
- Existing runtime APIs, connector modules, mock data, and scenario conventions in the target project.
- Optional acceptance cases or business branches that must be covered by Workflow Testing.

## Workflow

1. Read the repository's local authoring rules before changing code.
2. Draft or update `procedure.md` first. Treat it as the source of business truth. Do not generate `workflow.yaml`, connector code, workflow code, mock data, or tests until the procedure is explicit enough to compile.
3. Inspect existing workflow artifacts and runtime APIs only for technical contracts:
   - Search for `workflow<`, `patch(`, `prefetch(`, `derive(`, `command(`, `render(`, and existing `*.workflow.ts`.
   - Reuse local import paths, connector patterns, file names, test shape, and language style.
   - Do not copy or infer business logic from an existing scenario unless the new procedure states the same rule.
4. Normalize the procedure into one workflow objective:
   - `id`, `version`, `description`, `routing.examples`, `routing.entities`, `routing.neighbors`
   - durable business state fields
   - user-expressible patch fields
   - baseline prefetch reads
   - state-dependent derive reads and deterministic decisions
   - irreversible command side effects
   - downstream invalidation
   - render behavior
5. Generate or update these files as one artifact set from the normalized procedure:
   - `procedure.md`
   - `workflow.yaml`
   - `<workflow_id>.workflow.ts`
   - `connectors.ts`
   - `mockData.ts`
6. Keep the workflow file self-contained for workflow-owned business schemas and decisions. Keep connector refs, connector implementations, and mock data outside the workflow file.
7. Use `workflow<State, ConnectorCatalog>({...})` and declare steps in business order: `patch`, `prefetch`, `derive`, `command`, then `render`.
8. Use `context.call("connectors.xxx", input)` for all connector calls. Do not import concrete connector refs, service functions, mock data, or LLM clients into the workflow artifact.
9. Use `prefetch` for baseline read-only facts, `derive` for idempotent recommendation/selection/draft work, and `command` only for explicit externally mutating actions.
10. Render is the only user-visible response path. It must answer from runtime messages, state, and tool results without changing state or calling tools.

## Generation Rules

- Patch extraction only writes facts directly expressed by the latest user message or selected from already visible conversation options.
- The procedure decides the business phases. Existing examples can validate runtime shape, but they must not decide what the new workflow does.
- Do not use local text classifiers to infer user intent. If a phrase must be resolved against external data, model it as state and resolve it through workflow steps or patch from visible options.
- Connector reads that produce candidates should usually append `ToolMessage` results and store only small cache keys in context.
- Committed external records must be represented by explicit state fields returned from `command`, not by a bare confirmation flag.
- State changes must invalidate stale downstream fields, but committed records should not be cleared unless the procedure explicitly says to replace or cancel them.
- Every step needs a `progress` string and a `description` that states purpose, inputs, outputs, and side-effect boundary.
- When a business API, data model, or policy is underspecified, make a conservative mock boundary and document the assumption in `procedure.md` or render instructions, not in hidden code behavior.

## Validation

After generation, run Workflow Testing for the scenario. At minimum:

- Type-check the workspace.
- Validate workflow metadata and connector wiring.
- Exercise every `workflow.yaml` case with deterministic patches.
- Cover edge cases for invalidation, missing data, connector failure, and irreversible command guards.

The older `pac-dynamic-workflow` skill remains compatible with this Creator skill; use its `references/pac-workflow-rules.md` as the detailed runtime rulebook when present.
