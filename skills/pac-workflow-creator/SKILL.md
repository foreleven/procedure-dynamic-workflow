---
name: pac-workflow-creator
description: "Create or update a single-file PAC Dynamic Workflow TypeScript artifact from a specified procedure file. Use only when the user provides a procedure file path or asks to compile a concrete procedure into one workflow file. The skill focuses on translating the procedure's business meaning into state, connector ref schemas, patch instructions, deterministic effects, optional commands, and render instructions without generating scenario folders, agent.yaml, mock data, tests, or reusable shared modules."
---

# PAC Workflow Creator

Use this skill to compile one business procedure file into one PAC workflow file.

The output must be a single TypeScript ESM workflow artifact. Do not create or require `agent.yaml`, `connectors/*.ts`, `mockData.ts`, tests, shared helpers, or reusable modules. Do not design for reuse across procedures. Put all workflow-local schemas, connector refs, metadata, state, invalidation, patch, prefetch, effect, command, render, and small helper functions in the same file.

## Input Contract

This skill only applies when the user specifies a procedure file. If no procedure file path is provided, ask for the procedure file path and stop.

Treat the procedure file as the only business source of truth. Do not import business rules from nearby workflows, examples, or project conventions. Existing code may help with syntax, but it must not supply missing business behavior.

Before writing the workflow, read the procedure end to end and extract:

- The user goal and completion condition.
- Actors, external systems, and every named connector/tool.
- Business objects and lifecycle, such as application, booking, claim, order, ticket, draft, or committed record.
- Facts the user can express directly.
- Facts only connectors can provide.
- Candidate selection points and confirmation points.
- Irreversible or externally mutating actions.
- Cancellation, replacement, failure, and data-unavailable rules.
- Response obligations, compliance limits, and language/style requirements.

If the procedure does not define a rule that affects state shape, connector input, side-effect safety, or user-visible obligations, ask for clarification. Do not silently invent the rule.

## Connector Understanding

For every connector mentioned by the procedure, understand the tool contract before coding:

- Stable connector id to call, such as `connectors.domain.toolName`.
- Business purpose and read/write boundary.
- Exact input parameters, required vs optional fields, allowed enums, time zone/date formats, units, ids, and nested objects.
- Output fields that are authoritative business facts.
- Failure modes and whether no-result is a valid business outcome.
- Whether the call is read-only/idempotent and can use `{ cache: true }`.

Declare connector refs and their input/output schemas inside the workflow file. The workflow artifact describes the contract and calls the connector; it does not implement the connector, create a registry, import mock data, or call external services directly.

Use this single-file pattern:

```ts
import {
  ToolMessage,
  defineConnectorCatalog,
  defineConnectorRef,
  defineRouting,
  workflow,
  z,
} from "@pac/workflow";

const lookupThingConnector = defineConnectorRef({
  id: "connectors.example.lookupThing",
  description: "Read-only lookup described by the procedure.",
  inputSchema: z.object({
    query: z.string().min(1),
  }),
  outputSchema: z.object({
    id: z.string(),
    label: z.string(),
  }).nullable(),
});

const connectorCatalog = defineConnectorCatalog({
  "connectors.example.lookupThing": lookupThingConnector,
});

type ConnectorCatalog = typeof connectorCatalog;
```

Call connectors only through `context.call("connectors.example.lookupThing", input)`. Use `context.call(id, input, { cache: true })` for repeated idempotent reads whose full JSON input is the cache boundary. Use a custom `cacheKey` only when the procedure defines a different reuse boundary.

## State Design

Design state before writing nodes. State is durable business truth across turns, not a scratchpad.

For each state field, decide:

- Business meaning from the procedure.
- Zod type and default value.
- Writer: patch, prefetch, effect, or command.
- Invalidation rule when upstream state changes.
- Persistence rule, especially whether it survives ordinary preference edits.
- Why it belongs in state instead of runtime context or a `ToolMessage`.

Prefer:

- `status` or `phase` for compact lifecycle progress.
- User-expressible facts: intent, preferences, quantities, dates, consent, selected option references.
- Stable selected refs copied from known connector/tool facts.
- Draft objects prepared before confirmation.
- Committed records returned by irreversible actions.
- Blocking/failure reason only when it changes future turns or render behavior.

Avoid:

- Candidate lists, search results, and large connector payloads. Put them in `ToolMessage` for render.
- Raw external payloads whose fields are not part of the business state.
- Derived display text.
- Booleans that hide the real record, such as `submitted: true` without a committed record.
- `messages`, which is reserved by the runtime.
- `undefined` as business meaning; use nullable fields for unknown facts.

Add invalidation immediately after state design. Clear stale downstream selections, drafts, and estimates when upstream user-editable fields change. Do not clear committed records unless the procedure explicitly defines replacement or cancellation.

## Workflow Shape

Use the program DSL in this order:

```ts
const StateSchema = z.object({
  status: z.enum(["collecting", "ready", "submitted", "cancelled"]),
  need: z.string().nullable(),
  selectedOption: z.object({
    id: z.string(),
    label: z.string(),
  }).nullable(),
  draft: z.object({
    id: z.string(),
  }).nullable(),
});

type State = z.infer<typeof StateSchema>;

const initialState = StateSchema.parse({
  status: "collecting",
  need: null,
  selectedOption: null,
  draft: null,
});

const invalidation = {
  need: ["selectedOption", "draft"],
  selectedOption: ["draft"],
} satisfies Partial<Record<keyof State & string, Array<keyof State & string>>>;

const { patch, prefetch, effect, command, render } = workflow<State, ConnectorCatalog>({
  id: "procedure_id",
  version: "0.1.0",
  description: "One sentence business purpose from the procedure.",
  routing: defineRouting({
    examples: ["User utterances that should route here"],
    entities: ["business entities"],
  }),
  stateSchema: StateSchema,
  state: initialState,
  invalidation,
  connectors: connectorCatalog,
});

patch({ ... });
prefetch("baseline", { ... });
effect("resolveOrLookup", ["need"], { ... });
command("commit", { ... });

export default render({ ... });
```

Omit `prefetch` or `command` when the procedure has no baseline read or irreversible action. Keep helper functions small and local to this file.

Every `prefetch`, `effect`, and `command` needs a `description` that states purpose, inputs, outputs, and side-effect boundary. `prefetch` also needs `progress`. Effects do not use `when`; put business guards at the start of `run`. Commands must use `when` because they are the irreversible side-effect gate.

## Patch Instructions

Patch extracts only facts directly expressed by the latest user message or selected from visible conversation options. It does not call connectors, create records, invent ids, choose prices/availability, or answer the user.

Make the patch schema smaller than the full state schema. Include only fields the user can express or select:

- User preferences and requirements.
- Explicit cancellation or confirmation intent.
- Selected known objects from prior options.
- Concrete date/time expressions when the procedure asks for them.

Do not include fields only a connector can know, such as eligibility, availability, price, generated ids, drafts, committed records, or system recommendations.

Write patch instructions as an extraction contract:

- State that the latest user message is the only source of new facts.
- Explain how prior assistant messages and tool results may be used only to resolve references like "the first one" or "same dealer".
- List each patchable field and its exact extraction rule.
- Define when to leave a field unchanged.
- Define cancellation and confirmation wording precisely.
- Define date/time normalization, time zone, unit, and range assumptions when the procedure requires them.
- For selections, require copying the full known object exactly from shown options or tool facts; never synthesize missing fields.
- Explicitly forbid final replies, connector calls, invented records, and internal labels.

Patch should reset lifecycle state only when the latest user message changes upstream business facts or explicitly cancels/confirms. It should not mark a command as ready from vague intent.

## Prefetch

Use `prefetch` only for baseline read-only facts that do not depend on newly patched state, usually keyed by stable session data such as `session.userId`.

Good prefetch examples:

- Customer profile.
- Existing accounts or owned assets.
- Current contract context.
- Baseline permissions.

Keep prefetch output in runtime context unless the procedure says the fact must become durable workflow state. Isolate optional baseline failures when the procedure allows continuing without them.

## Effects

Effects perform deterministic, idempotent business progression after patch. They are the main place to turn procedure meaning into workflow behavior.

Use effects to:

- Check readiness and set blockers.
- Resolve user-expressed facts against connector facts.
- Load candidates based on current state.
- Auto-select only when the procedure explicitly permits it.
- Prepare drafts that still need user confirmation.
- Add `ToolMessage` entries for facts render must see.

For each effect, define:

- Triggering state dependencies via `effect(name, ["field"], config)`.
- Guard conditions at the top of `run`.
- Connector input assembled from validated state and procedure-defined parameters.
- Returned partial state.
- Tool messages to expose connector facts to render.
- Failure or no-result behavior.

Effects must be repeatable. They must not perform irreversible external mutations. Wrap visible long work with `step.start("...")` and `loading.end(...)`.

Use `ToolMessage` for connector facts:

```ts
effect("loadCandidates", ["need"], {
  description: "Reads candidate options for the current need; candidates are exposed to render and are not durable state.",
  run: async (state, context, _runtime, step) => {
    if (!state.need) return {};

    const loading = step.start("读取候选项");
    const candidates = await context.call("connectors.example.searchCandidates", {
      need: state.need,
    }, { cache: true });
    loading.end({ count: candidates.length });

    return {
      messages: [
        new ToolMessage({
          name: "connectors.example.searchCandidates",
          call: { need: state.need },
          result: candidates,
        }),
      ],
    };
  },
});
```

## Commands

Use `command` only for irreversible or externally mutating actions, such as submit, pay, book, cancel, or create a committed record.

A command must require explicit state evidence from the procedure:

- Complete draft or selected option.
- Required user confirmation or consent.
- No existing committed record unless replacement is allowed.
- Any required compliance or eligibility blocker cleared.

Command failure must not write a committed record. Ordinary preference changes must not erase committed records unless the procedure explicitly defines replacement/cancellation behavior.

## Render Instructions

Render is the only user-visible response path. It does not mutate state and does not call connectors.

Write render instructions as a response policy:

- Use current state as authoritative.
- Use tool messages and prefetch facts as supporting evidence.
- Answer the user's latest follow-up before asking the next action.
- Ask the next smallest necessary question when required facts are missing.
- Present connector candidates as options, not as selected facts.
- Explain blockers and no-result cases using procedure language.
- Show draft details and ask for confirmation before any command.
- Confirm committed outcomes from committed state or the latest command tool result.
- Follow the procedure's compliance, safety, and tone requirements.
- Never expose JSON, state field names, workflow terms, connector syntax, tool-call markup, or internal decision labels.
- Never fabricate connector facts, availability, prices, ids, eligibility, or records.

Order render branches from terminal to earlier states:

1. Cancelled or completed committed outcome.
2. Command failure or blocking condition.
3. Draft ready and awaiting confirmation.
4. Candidate/options available and awaiting selection.
5. Missing user-provided facts.
6. General clarification or unsupported request within this procedure.

Keep replies concise unless the procedure requires detailed explanation.

## Final Self-Check

Before finishing, verify:

- A procedure file was specified and used as the business source.
- The output is one workflow file only.
- No project-level required reads, scenario files, reusable modules, mock data, or tests were added.
- Every connector's input/output schema matches the procedure-described tool parameters.
- State fields trace to procedure business meaning and have clear writers.
- Patch writes only latest user-expressed or visibly selected facts.
- Effects are deterministic/idempotent and own candidate lookup, readiness, draft preparation, and blockers.
- Commands are the only irreversible mutation path and require explicit evidence.
- Render uses state/tool facts only and never exposes internals.
- Invalidation clears stale downstream state without erasing committed records.
- Local imports use runtime `.js` suffixes only if any local import is unavoidable; normally there should be no local imports.
