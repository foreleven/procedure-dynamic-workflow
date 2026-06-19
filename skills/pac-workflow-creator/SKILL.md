---
name: pac-workflow-creator
description: "Create or update a PAC Dynamic Workflow TypeScript artifact from a specified procedure file. Use when the user provides a procedure file path or asks to compile a concrete procedure into one workflow file. Translate the procedure's business meaning into durable business state, connector contracts, patch extraction, deterministic prefetch/effect/command nodes, invalidation, visible step progress, parallel connector reads, and render instructions without generating scenario folders, agent.yaml, mock data, tests, or shared modules unless explicitly requested."
---

# PAC Workflow Creator

Use this skill to compile one business procedure into one PAC workflow module.

If no procedure file path is provided, ask for the path and stop. Treat the procedure as the only business source of truth. Nearby code may teach syntax and local naming, but it must not supply missing business rules.

## Required References

Read these files before writing or substantially changing a workflow:

- `references/state-design.md`: state modeling rules. Always read this first; state is business truth, not a connector parameter aggregate.
- `references/workflow-authoring.md`: connector, patch, prefetch, effect, command, render, and final self-check rules.

## Output Boundary

Produce one workflow TypeScript file by default. Do not create or require `agent.yaml`, connector implementations, mock data, tests, scenario folders, shared helpers, or reusable modules unless the user explicitly expands the task.

Choose the module style from the target:

- Agent workflow under `agents/**/workflows`: export a manifest-backed template. Do not put `id`, `version`, `description`, or `routing` in `workflow(...)`; `agent.yaml` owns stable metadata. Import only connector catalog types from connector files when they already exist.
- Standalone workflow artifact: include local connector refs/catalog and metadata only when the user explicitly asks for a complete standalone definition.

Never import mock data, service functions, connector tools, or an LLM client from the workflow file. Connector calls go only through `context.call("connectors.xxx", input)`.

## Work Order

1. Read the procedure end to end.
2. Extract the business goal, completion condition, actors, external systems, connector/tool names, business objects, lifecycle, user-expressible facts, connector-only facts, selection points, confirmation points, irreversible actions, failures, cancellation/replacement rules, and response obligations.
3. Design state before writing nodes. Follow `references/state-design.md`; keep the state as small as the procedure allows, and collapse, default, or ignore connector parameters that are not durable business facts.
4. Confirm connector contracts: ids, read/write boundary, required inputs, optional/defaulted inputs, output facts, failure modes, and cacheability.
5. Plan connector execution before coding nodes: identify calls that can run concurrently, calls that depend on prior connector output, and expensive phases that need visible `step.start(...)` / `end(...)` progress.
6. Implement the workflow in DSL order: schemas and local helpers, initial state, invalidation, `workflow(...)`, `patch`, `prefetch`, `effect`, `command`, `render`.
7. Keep changes surgical. Add only fields, nodes, and helpers required by the procedure.
8. Run TypeScript checks or the closest relevant validation when code changes are made. For docs-only changes, validate the skill folder if possible.

Ask for clarification when a missing rule affects state shape, connector input, side-effect safety, or user-visible obligations. Do not hide business guesses in code.

## Minimal Shape

```ts
import { workflow, z } from "@pac/workflow";
import type { ConnectorCatalog } from "../connectors/main.js";

const StateSchema = z.object({
  status: z.enum(["collecting", "ready", "submitted", "cancelled"]),
  request: z.string().nullable(),
  selectedOptionId: z.string().nullable(),
  committedRecordId: z.string().nullable(),
});

type State = z.infer<typeof StateSchema>;

const initialState = StateSchema.parse({
  status: "collecting",
  request: null,
  selectedOptionId: null,
  committedRecordId: null,
});

const invalidation = {
  request: ["selectedOptionId"],
} satisfies Partial<Record<keyof State & string, Array<keyof State & string>>>;

const { patch, prefetch, effect, command, render } = workflow<State, ConnectorCatalog>({
  stateSchema: StateSchema,
  state: initialState,
  invalidation,
});

patch({ ... });
prefetch("baseline", { ... });
effect("prepareDraft", ["selectedOption"], { ... });
command("commit", { ... });

export default render({ ... });
```

Omit `prefetch` when there is no baseline read. Omit `command` when the procedure has no irreversible or externally mutating action. Keep helper functions local and small.

Every `prefetch`, `effect`, and `command` needs a `description` that states purpose, inputs, outputs, and side-effect boundary. `prefetch` also needs `progress`. Effects do not use `when`; put guards at the start of `run`. Commands must use `when` as the irreversible side-effect gate.

## Connector Execution And Steps

Inside a single node, do not serialize connector calls by default. Run independent read-only calls with `Promise.all`, especially searches, candidate lookups, site maps, profile reads, availability reads, or per-item enrichment that share the same state snapshot. Keep true dependencies sequential: extract pages only after search/map returns URLs, prepare a draft only after required candidates are resolved, poll an async task only after it has a request id.

Expose meaningful progress for every expensive or user-visible phase with `step.start(...)` and `end(...)`. Prefer several scoped steps over one vague loading step when a node does multiple phases, such as search, news lookup, site mapping, extraction, crawl, draft creation, submit, or polling. Include concise diagnostic detail in `end(...)`, such as counts, selected ids, success/failure status, or skipped branches. Do not create steps for trivial synchronous guards.

When parallelizing, preserve render evidence order intentionally: collect connector messages into a predictable order after `Promise.all`, and keep raw results out of state unless the procedure says they are durable business facts.

## Final Check

Before finishing, verify:

- The procedure file was specified and used as the business source.
- State fields are the smallest durable procedure business facts; they do not model raw tool parameters, intermediate query plans, search results, candidate arrays, or display text.
- Connector parameters were merged, defaulted, trimmed, or ignored where appropriate.
- Independent connector reads are parallelized; only true data dependencies remain sequential.
- Expensive connector phases expose specific `step.start(...)` / `end(...)` traces with useful details.
- Patch writes only latest user-expressed or visibly selected facts.
- Effects are deterministic/idempotent and own candidate lookup, readiness, draft preparation, and blockers.
- Commands are the only irreversible mutation path and require explicit evidence.
- Render uses state/tool facts only and never exposes internals.
- Invalidation clears stale downstream state without erasing committed records unless the procedure explicitly allows replacement or cancellation.
- Local relative imports use runtime `.js` suffixes.
