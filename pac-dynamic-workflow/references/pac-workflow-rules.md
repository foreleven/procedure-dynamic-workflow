# PAC Dynamic Workflow Rules

## Runtime Shape

Generate `workflow.yaml` for stable metadata:

```yaml
id: maintenance_booking
version: 1.0.0
description: Vehicle maintenance booking, modification, cancellation, and status lookup
routing:
  examples:
    - Book maintenance
    - Change my appointment time
    - Cancel my appointment
  entities:
    - vehicle
    - dealer
    - appointment
    - preferredDate
    - slot
  neighbors:
    - vehicle_diagnosis
```

Generate the TypeScript workflow with the `workflow()` program DSL. Import `ToolMessage` from `@pac/workflow` when a `derive` or `command` step returns connector results through `messages`.

```ts
const metadata = loadWorkflowMetadata(import.meta.url)

const { patch, prefetch, derive, command, render } = workflow<State, ConnectorCatalog>({
  ...metadata,
  stateSchema,
  state,
})

patch({ state: patchFields, invalidates, progress: "Understanding request", instruction: patchInstruction })
prefetch("profile", {
  progress: "Loading customer profile",
  description: "Load baseline customer facts that do not depend on the latest message patch.",
  when: () => true,
  cacheKey: (_state, _context, { session }) => session.userId,
  run: (_state, context, { session }) => ({
    customer: context.call("connectors.customer.get", { userId: session.userId }),
    vehicles: context.call("connectors.vehicle.list", { userId: session.userId }),
  }),
})
derive("resolveCustomerIntent", {
  progress: "Resolving customer intent",
  description: "Resolve latest-message references against read-only data and write concrete business state.",
  when: (state, context) => Boolean(!state.vehicle && context.get("vehicles")),
  run: (_state, context) => {
    const [vehicle] = context.get<Array<{ id: string }>>("vehicles") ?? []
    return vehicle ? { vehicle } : {}
  },
})

export default render({
  name: "workflow_reply",
  progress: "Writing reply",
  instruction: "Write one concise user-facing reply from the latest workflow message log. Do not change state, call tools, or invent facts.",
})
```

The runtime accepts this as a `WorkflowDefinition` with executable `nodes`. The DSL compiles `prefetch`, `derive`, and `command` declarations into nodes; do not generate alternate workflow shapes.
Do not generate `contextSchema`, initial `context`, or `context.*` paths. Runtime `context` is an in-memory KV store created by the engine for the current session.

## Core Model

- `SessionContext`: conversation-level memory shared across workflows.
- `WorkflowDefinition`: compiled executable workflow definition with ordered nodes.
- `WorkflowInstance`: per-session workflow state and runtime context KV store.
- `context`: in-memory runtime KV store exposed as `context.get/set/delete/clear/call`. Prefetch results are written here by the program DSL, connector calls go through `context.call(...)`, and the store may contain non-serializable temporary objects.
- `state`: mutable business facts such as selected item, preferred time, draft, confirmation, cancellation request, or current status.

Use `state` for business facts that must survive turns and be inspectable/recoverable. Use `context.get(...)` for current-session read results or scratch runtime data. Do not use `ProgramInput`, `input.data`, or `input.prefetch` in generated workflows.

Every user message must go through the workflow `patch` LLM. The patch extracts structured deltas only; business connector calls and state derivation happen in nodes.

## Compilation Checklist

1. Identify one stable business objective per workflow.
2. Put `id`, `version`, `description`, and `routing` in `workflow.yaml`.
3. Define workflow-owned Zod schemas for domain records, state, patch fields, and structured LLM node outputs. Define connector input/output Zod schemas in the connector/host module, then import only the connector catalog type into the workflow.
4. Use `patch({ state, invalidates, instruction })` for latest-message state extraction. Patch fields may include unresolved user references such as `vehicleRequest` or `dealerRequest`, but must not include fetched records such as full vehicles, dealers, slots, drafts, or bookings.
5. Define invalidation from upstream state fields to downstream computed fields.
6. Declare business steps with the program DSL:
  - `prefetch`: baseline read-only data needed by patch, keyed by session or other pre-patch facts.
  - `derive`: deterministic business state derivation and state-dependent connector reads. It may update state, but must not perform irreversible external mutation.
   - `command`: externally mutating or irreversible actions such as confirmation, cancellation, payment capture, or submission.
7. Keep each step idempotent where possible. The engine may run after-patch rounds until no node changes state or runtime context.
8. Do not generate `requires` or `writes`. Put all runtime eligibility checks in `when(state, context, runtime)`, including state readiness, `context.get(...)` data readiness, and business guards. Use `cacheKey` only for read identity and duplicate-read prevention.
9. Use `render(...)` as the only user-visible outlet.
10. Validate with `npm run check` and scenario/CLI smoke tests.

## File Organization

The skill-generated `*.workflow.ts` is the workflow distribution artifact. Keep workflow-owned business code in that one file so a generated workflow can be copied, reviewed, or published without chasing sibling modules.

- `workflow.yaml`: stable metadata, routing profile, and optional verification cases.
- `*.workflow.ts`: workflow-owned Zod schemas, defaults, patch policy, invalidation, business-phase step callbacks, render instructions, and `patch/prefetch/derive/command/render` declarations.
- `connectors.ts`: connector refs/catalog, host-side connector implementations, and type inference boundary.
- `mockData.ts`: demo data used by connector implementations.

Do not create extra workflow-local modules such as `*Models.ts`, `*Logic.ts`, `*Nodes.ts`, `*Render.ts`, or `*Reply.ts` for skill-generated workflows. Do not put connector implementations, mock data, or host service functions in the workflow file.

## Step Rules

Use these program methods:

- `patch({ state, invalidates, progress, instruction })`: every user message goes through this structured LLM patch. It writes only directly expressed user facts and invalidates stale downstream state.
- `prefetch(name, { progress, description, when, cacheKey, run })`: baseline read-only connector calls that must be visible to patch. Use this for profile, account, entitlement, or other data keyed by session rather than by newly patched state.
- `derive(name, { progress, description, when, run })`: business derivation that returns partial state directly, such as `{ vehicle, status }`. Use this for resolving contextual choices, state-dependent connector reads, preparing offers, selecting defaults, or building pending drafts when the operation is local/idempotent. If the step produces facts needed by patch/render but not durable business state, return new `messages: ToolMessage[]`; the runtime appends them. If scratch runtime data is needed, call `context.set(...)`; do not treat that scratch data as business truth.
- `command(name, { progress, description, when, run })`: irreversible or externally mutating action. It must require explicit state evidence such as `state.confirmed` and should write a committed state field like `state.booking` by returning partial state directly.
- `render({ name, progress, instruction })`: declare the runtime render LLM. The runtime supplies the latest `state.messages` as the message input and appends the returned assistant message. Do not define `messages` in the workflow state schema or initial state.

Every `prefetch`, `derive`, and `command` config must include:

- `progress`: short user-visible status text emitted when `when` matches and the node is selected.
- `description`: maintainer-facing explanation of what the step does, which facts it depends on, what it may update, and whether it has external side effects.
- `when(state, context, runtime)`: the complete eligibility check. The first two parameters are always `state` and runtime `context`; use `runtime.session`, `runtime.message`, or `runtime.turn` only when needed.
- `run(state, context, runtime)`: the implementation. `prefetch` returns a data object that the DSL writes into context and appends as a tool message; `derive` and `command` return partial state directly, not wrapped in a `state` property, and may return new `messages: ToolMessage[]` that the runtime appends.

Inline one-off `run` implementations in the node declaration so the procedure reads top-to-bottom. Keep separate helper functions only for reused pure domain rules or complex calculations that have a stable business name.

Prefer business-phase steps over field-plumbing steps. A workflow should read like the procedure: `prefetch("customerProfile")`, `derive("resolveCustomerIntent")`, `derive("eligibleOptions")`, `derive("prepareOffer")`, `derive("prepareDraft")`, `command("commitOrder")`. Do not split a single business decision into `resolveA`, `resolveB`, and `resolveC` only because it updates three state fields. Keep separate steps for baseline prefetch, irreversible side effects, and genuinely independent decisions.

When a business-phase effect returns multiple related state fields, treat that patch as one atomic decision. Invalidation should clear stale downstream fields from older state, but it should not erase fields explicitly returned by the same effect.

For state-dependent connector reads, prefer derive plus `runtime.preState` and existing tool messages to decide whether data must be refreshed:

```ts
derive("availableSlots", {
  progress: "Checking available appointment slots",
  description: "Fetch available slots when dealer/date are newly selected or changed; append candidates as a tool message for patch/render.",
  when: (state, _context, { preState }) =>
    Boolean(
      state.dealer &&
      state.preferredDate &&
      (
        state.dealer.id !== preState.dealer?.id ||
        state.preferredDate.start !== preState.preferredDate?.start
      ),
    ),
  run: async (state, context) => {
    if (!state.dealer || !state.preferredDate) return {}
    const availableSlots = await context.call("connectors.service.getAvailableSlots", {
      dealer: state.dealer,
      dateRange: state.preferredDate,
    })
    return {
      messages: [
        new ToolMessage({
          name: "connectors.service.getAvailableSlots",
          call: { dealerId: state.dealer.id, start: state.preferredDate.start },
          result: availableSlots,
        }),
      ],
    }
  },
})
```

## Patch Rules

Patch LLM instructions must:

- Extract structured updates from the latest user message.
- Use the runtime current-time boundary from the patch system instruction when resolving relative time.
- Avoid chain-of-thought, planning, final responses, connector calls, and invented records.
- Only update fields the user can express directly.

Do not build local extractors or regex intent classifiers for business state. If a choice needs contextual interpretation, have patch extract the user's unresolved phrase into state, then use a structured LLM node with a narrow Zod schema to resolve that phrase against current `context.get(...)` read results and state.

## Invalidation Rules

Invalidate downstream fields when users change upstream decisions:

```ts
const invalidation = {
  vehicle: ["dealer", "serviceType", "slot", "draft", "confirmed"],
  dealer: ["slot", "draft", "confirmed"],
  preferredDate: ["slot", "draft", "confirmed"],
  serviceType: ["slot", "draft", "confirmed"],
} satisfies Partial<Record<keyof State & string, Array<keyof State & string>>>
```

For workflows that support post-confirmation follow-up questions or edits, keep committed records separate from pending drafts. Do not automatically invalidate a committed `booking`, `order`, `application`, or similar record just because the user starts a pending change. Preserve the committed record, build a new draft for the change, and only replace or cancel the committed record through an explicit irreversible effect after confirmation.

Do not restart the workflow for edits like "change to Wednesday afternoon" or "use the previous dealer". Patch state, invalidate dependents, run needed nodes, then render.

## Connector Rules

Procedure text can reference external dependencies with markers such as `{@connectors.maintenance.getCustomer}`.

- Define or reuse a connector ref with `defineConnectorRef({ id, inputSchema, outputSchema })`.
- The connector id must match the marker without braces and `@`.
- Export a connector catalog with `defineConnectorCatalog({ "connectors.xxx": connectorRef })`.
- Import only the connector catalog type into the workflow for inference.
- Call connectors through `context.call("connectors.xxx", input)` inside `prefetch`, `derive`, and `command` callbacks. Do not use direct connector refs or `deps.connectors.call(...)` from generated workflow code.
- Do not import concrete service implementations, connector refs, connector tools, connector schemas, or mock data into the workflow file.
- Host/application code registers connector implementations with `defineConnectorTool(ref, execute)` and injects a `ConnectorRegistry` into `WorkflowEngine`.

## Render Rules

Render returns user-visible text only. Runtime does not carry or interpret response type.

- Declare render with exactly string `name`, `progress`, and `instruction`. Do not pass a render function from workflow code.
- The runtime calls the default LLM for render and passes the latest `state.messages` as messages, not a JSON object assembled from state/context. `messages` is runtime-added and must not be part of the workflow state schema/default.
- Do not import or call `llm(...)`, `deps.llm`, or custom LLM clients from workflow code.
- Do not return `type`, `kind`, `decision`, or runtime response-status labels.
- Business lifecycle belongs in state, such as `draft`, `booking`, `confirmed`, `cancelled`, or domain-specific fields.
- Prefer one render instruction that tells the LLM how to answer from the message log. If render needs data, expose it before render through prefetch tool messages or by returning new `messages` from derive/command.
- Do not create one render case per phrasing variant. If render needs a small guard, it should protect facts passed to the LLM, not recreate a response-type state machine.
- For irreversible confirmation flows, the committed business state such as `state.booking` is the source of truth. Do not treat a bare `confirmed` flag as completion unless a command has actually committed the record.
- Do not add one state intent per possible user question. Pass current booking/order/request facts and relevant history to the render LLM so it can answer naturally.
- The render LLM must not change business facts, call connectors, or invent availability.

## Minimal Workflow Skeleton

```ts
import {
  z,
  loadWorkflowMetadata,
  workflow,
} from "@pac/workflow"
import type { ConnectorCatalog } from "./connectors.js"

const StateSchema = z.object({
  preferredDate: z.object({ label: z.string(), start: z.string(), end: z.string() }).nullable(),
  draft: z.object({ id: z.string() }).nullable(),
  booking: z.object({ id: z.string(), confirmationCode: z.string() }).nullable(),
  confirmed: z.boolean(),
})

type State = z.infer<typeof StateSchema>
const metadata = loadWorkflowMetadata(import.meta.url)

const { patch, prefetch, derive, command, render } = workflow<State, ConnectorCatalog>({
  ...metadata,
  stateSchema: StateSchema,
  state: StateSchema.parse({ preferredDate: null, draft: null, booking: null, confirmed: false }),
})

patch({
  progress: "Understanding booking request",
  state: {
    preferredDate: StateSchema.shape.preferredDate,
    confirmed: z.boolean(),
  },
  invalidates: {
    preferredDate: ["draft", "confirmed"],
  },
})

prefetch("customer", {
  progress: "Loading customer profile",
  description: "Fetch customer profile once per user before business derivation; this is read-only and can run with patch extraction.",
  when: () => true,
  cacheKey: (_state, _context, { session }) => session.userId,
  run: (_state, context, { session }) => ({
    customer: context.call("connectors.customer.get", { userId: session.userId }),
  }),
})

derive("prepareDraft", {
  progress: "Preparing booking draft",
  description: "Create a local/idempotent draft after the user has provided a preferred date and no draft exists yet.",
  when: (state) => Boolean(state.preferredDate && !state.draft),
  run: async (state, context) => ({
    draft: await context.call("connectors.booking.createDraft", { dateRange: state.preferredDate }),
  }),
})

command("commitBooking", {
  progress: "Submitting booking",
  description: "Commit the prepared draft only after explicit confirmation; this is the irreversible booking side effect.",
  when: (state) => Boolean(state.confirmed && state.draft && !state.booking),
  run: async (state, context) => ({
    booking: await context.call("connectors.booking.confirm", { draft: state.draft }),
  }),
})

export default render({
  name: "booking_reply",
  progress: "Writing reply",
  instruction: "Write one concise user-facing booking response from the latest workflow message log. Ask for missing facts, confirm drafts, answer follow-up questions, or report committed results naturally. Do not change state, call tools, or invent facts.",
})
```

Adapt the skeleton to the project. Do not copy fields that are not in the procedure.
