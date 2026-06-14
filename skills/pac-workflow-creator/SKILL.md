---
name: pac-workflow-creator
description: "Compile a natural-language business procedure into PAC Dynamic Workflow scenario artifacts. Use when creating or updating PAC workflows, procedure.md, workflow.yaml, connector contracts, mock data, workflow() program DSL steps, state schemas, invalidation, command guards, render policy, or scenario acceptance cases. The core method is state-first: design durable workflow state from the business procedure before writing patch, prefetch, derive, command, or render logic."
---

# PAC Workflow Creator

Use this skill to turn a user's business procedure into a PAC workflow scenario. The workflow is a state machine driven by conversation, connector facts, deterministic derivations, and explicit commands. Always design the workflow state first; the rest of the artifact follows from that state.

## Required First Reads

Before editing code, read:

- The repository `AGENTS.md`.
- The target scenario's `procedure.md` when it exists.
- Existing nearby scenario files only for technical conventions: `workflow.yaml`, `*.workflow.ts`, `connectors.ts`, `mockData.ts`, and runner/test shape.
- `pac-dynamic-workflow/references/pac-workflow-rules.md` when present and you need detailed runtime rules.

Do not copy business rules from another scenario unless the user's procedure states the same rule.

## Compilation Order

Follow this order. Do not start workflow implementation before the state plan is clear.

1. Stabilize the procedure.
2. Design the workflow state.
3. Design invalidation.
4. Design connector contracts and mock data boundaries.
5. Write `workflow.yaml`.
6. Write `connectors.ts` and `mockData.ts`.
7. Write `<workflow_id>.workflow.ts` in DSL order: `patch`, `prefetch`, `derive`, `command`, `render`.
8. Add or update deterministic validation.

If the user asks for only part of the scenario, such as connectors only, do only that part and preserve the same boundaries.

## Procedure First

Treat `procedure.md` as the source of business truth. If the user provides a procedure in chat, create or update `procedure.md` unless they explicitly ask not to.

Keep `procedure.md` business-facing. It should describe user situations, business rules, required information, tool/API usage policy, side-effect rules, and response obligations. Do not write workflow implementation details into it: no state tables, no schema names, no patch/prefetch/derive/render terminology, no invalidation plan, and no writer ownership.

Normalize the procedure into business facts:

- User goal and workflow completion condition.
- Actors and external systems.
- Business objects with lifecycles, such as application, booking, order, consultation, payment, claim, or ticket.
- User-provided facts.
- System-provided facts.
- Candidate selection points.
- Draft records.
- Irreversible external actions.
- Cancellation, replacement, and failure rules.
- Compliance or safety constraints.
- Acceptance cases.

Ask for clarification only when a missing rule changes state shape or side-effect safety. If a connector API or data source is unknown, create a conservative mock boundary and document the assumption in `procedure.md`.

## State-First Design

Design state as the durable business truth the workflow must remember across turns. State is not a scratchpad.

Before coding the workflow, produce or mentally complete a state plan with these columns:

| Field | Type/default | Business meaning | Writer | Invalidates | Persistence rule |
| --- | --- | --- | --- | --- | --- |
| `selectedThing` | `ThingRef \| null` | User-confirmed choice | patch or derive | draft, quote | Clear when upstream preference changes |
| `committedRecord` | `Record \| null` | External side effect already created | command only | none by default | Never clear unless procedure says replace/cancel |

Every state field must have:

- A business reason from the procedure.
- One allowed writer: patch, prefetch, derive, or command.
- A schema type and default value.
- A clear invalidation rule.
- A reason it belongs in state rather than runtime `context`, `prefetch`, or `ToolMessage`.

Prefer this state shape:

- `status` or `phase`: compact progress through the business lifecycle when useful.
- User-expressible facts: preferences, need, time window, amount, product type, consent, yes/no decisions.
- Selected stable refs: chosen vehicle, dealer, product, account, plan, slot, case, etc.
- Draft object: prepared but not yet committed external record.
- Committed object: record returned by an irreversible command.
- Failure or blocking reason only when it affects future turns.

Avoid storing:

- Large candidate lists from connector reads. Put them in `ToolMessage` for render or in runtime `context` with a cache key.
- Raw connector payloads that are not business state.
- Derived display text.
- Boolean flags that hide the actual business record, such as `submitted: true` without a committed record.
- Anything owned by runtime, especially `messages`.

Use nullable fields for unknown business facts. Do not let `undefined` carry business meaning in state.

## Derive The Workflow From State

After the state plan is clear, derive each workflow part from it.

### Patch

Patch only extracts facts directly expressed by the latest user message or selected from visible conversation options.

- Patch writes only user-expressible state fields.
- Patch never calls connectors.
- Patch never creates records, ids, prices, availability, eligibility, or final replies.
- Patch schema should be smaller than state schema.
- If a field can only be known from a connector, it is not a patch field.
- Do not add retry or fallback retry for patch structured output. Fix the schema or instruction.

### Prefetch

Prefetch loads baseline read-only facts that do not depend on newly patched state, usually by stable keys such as `session.userId`.

- Use it for customer profile, owned assets, existing account context, and other session baseline facts.
- Keep outputs in prefetch storage or context unless the procedure requires them as durable state.
- Isolate failures when possible so one missing baseline read does not break unrelated paths.

### Derive

Derive handles deterministic, idempotent business progression after patch.

Use derive to:

- Resolve user facts against connector facts.
- Load candidates based on current state.
- Auto-select when the procedure permits it.
- Prepare drafts.
- Set status or blocking reasons.
- Add `ToolMessage` entries with connector facts needed by render.

Derive must be repeatable. It must not perform irreversible external mutations.

### Command

Command is only for irreversible or externally mutating actions.

Use command only when state contains explicit evidence required by the procedure, such as a selected option, a complete draft, and user confirmation.

- Command writes committed records returned by the external system.
- Command should not run from vague intent alone.
- Command failure must not write a committed record.
- Ordinary preference changes should not clear committed records unless the procedure explicitly allows replacement or cancellation.

### Render

Render is the only user-visible response path.

- Render does not mutate state.
- Render does not call connectors.
- Render answers from state, runtime messages, prefetch facts, and tool results.
- Render must not expose JSON/type/kind/decision labels.
- Render asks the next smallest necessary question, presents available options, explains blockers, or confirms committed outcomes.

## Invalidation Design

Build invalidation immediately after state design, before writing nodes.

For each user-editable upstream field, list downstream state that becomes stale when it changes. Typical examples:

- Need amount changes invalidate product match, selected product, repayment estimate, draft lead.
- Date range changes invalidate available slots, selected slot, booking draft.
- Selected account changes invalidate transfer draft.

Do not invalidate:

- Baseline profile facts because of normal preferences.
- Committed records unless the procedure has an explicit replace/cancel path.
- Runtime `messages`.

When two possible invalidation strategies exist, choose the narrower one that preserves valid user work.

## Connector Boundaries

Connector contracts belong in `connectors.ts`; mock records belong in `mockData.ts`; workflow files import only connector catalog types.

Use:

- `defineConnectorRef`
- `defineConnectorCatalog`
- `defineConnectorTool`
- `createConnectorRegistry`
- Zod input and output schemas

Connector ids should be stable and namespaced, such as `connectors.<scenario>.getCustomer`.

Every connector must have:

- Input schema.
- Output schema.
- Description.
- Implementation boundary: read-only, idempotent write, or irreversible write.

Workflow code calls connectors through `context.call("connectors.xxx", input)`. It must not import concrete connector tools, service functions, mock data, or LLM clients.

## Workflow File Shape

Use the local program DSL:

```ts
const { patch, prefetch, derive, command, render } = workflow<State, ConnectorCatalog>({
  id,
  version,
  description,
  routing,
  stateSchema,
  state,
  invalidation,
});

patch(...);
prefetch(...);
derive(...);
command(...);

export default render(...);
```

Keep workflow-owned schemas and decisions in the workflow file. Keep connector schemas in `connectors.ts` when they describe external API payloads. Reuse exported connector output types only through catalog typing when needed.

Every `prefetch`, `derive`, and `command` needs:

- Short `progress`.
- `description` explaining purpose, inputs, outputs, and side-effect boundary.
- A `when` guard when running unconditionally would be wasteful or unsafe.

## Metadata And Acceptance Cases

`workflow.yaml` stores stable scenario metadata, not hidden business rules.

Include:

- `id`, `version`, and description.
- Routing examples that match user language.
- Entities and neighbor workflows when known.
- Acceptance cases that cover the main lifecycle and meaningful branches.

Acceptance cases should exercise state outcomes and side effects, not patch internals.

## Testing And Validation

After workflow or connector changes, run the narrowest useful checks:

- `npm run check` for TypeScript.
- Relevant unit tests or deterministic scenario tests.
- `npm test` when shared runtime behavior, package API, or broad scenario behavior changes.

Workflow tests must not assert raw patch intermediate output such as `statePatch` shape, order, or snapshot. Treat fake patches as inputs and assert applied business state, context, tool messages, command side effects, and rendered behavior.

Cover:

- Missing connector data.
- Connector failure.
- Upstream change invalidation.
- User follow-up that should not trigger command.
- Command failure not writing committed records.
- Replacement/cancellation rules when the procedure includes them.

Run LLM-backed scenario checks only when the user asks or the project expects a manual smoke test; report when they were skipped.

## Final Review Checklist

Before finishing, verify:

- The state fields all trace back to the procedure.
- Patch writes only user-expressed facts.
- Prefetch, derive, command, and render responsibilities do not overlap.
- Invalidation clears stale drafts and selections without erasing committed records.
- Connector ids, catalog keys, and implementation tools match.
- Workflow imports have `.js` suffixes for local files.
- No `any`, hidden text classifier, retry-on-patch, mock data import in workflow, or reserved `messages` state field.
- Documentation and acceptance cases changed when public behavior changed.
