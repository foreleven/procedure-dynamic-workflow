# Workflow Authoring Rules

Use these rules after state design is complete.

## Connector Contracts

For every connector mentioned by the procedure, understand before coding:

- Stable id to call, such as `connectors.domain.toolName`.
- Business purpose and read/write boundary.
- Exact inputs, including required vs optional fields, enums, ids, units, time zone, and date formats.
- Which inputs come from state, which come from session/context, and which are defaulted or ignored by procedure policy.
- Output fields that are authoritative business facts.
- Failure modes and whether no-result is valid.
- Whether the call is read-only/idempotent and can use `{ cache: true }`.

Declare connector refs and output schemas only when the workflow module is meant to be standalone. Otherwise import connector catalog types from existing connector modules. The workflow describes and calls the contract; it does not implement connectors, create registries, import mock data, or call external services directly.

Use `context.call("connectors.xxx", input)`. Use `context.call(id, input, { cache: true })` for repeated idempotent reads whose full JSON input is the cache boundary. Use a custom `cacheKey` only when the procedure defines a different reuse boundary.

## Workflow Shape

Use the program DSL in this order:

1. Imports.
2. Local schemas, helper types, and small helper functions.
3. `StateSchema`, `State`, `initialState`.
4. `invalidation`.
5. `workflow<State, ConnectorCatalog>({ stateSchema, state, invalidation })`.
6. `patch(...)`.
7. `prefetch(...)`.
8. `effect(...)`.
9. `command(...)`.
10. `export default render(...)`.

Agent workflow modules should not declare stable metadata in `workflow(...)`. Standalone complete workflow definitions may include `id`, `version`, `description`, `routing`, and local `connectors` only when explicitly required.

## Patch

Patch extracts only facts directly expressed by the latest user message or selected from visible conversation options. It does not call connectors, create records, invent ids, choose prices/availability, or answer the user.

Make the patch schema smaller than the full state schema. Include only:

- User preferences and requirements.
- Explicit cancellation or confirmation intent.
- Selected known objects from prior options.
- Concrete date/time expressions when the procedure asks for them.

Exclude connector-only facts, such as eligibility, availability, price, generated ids, drafts, committed records, and system recommendations.

Write patch instructions as an extraction contract:

- Latest user message is the only source of new facts.
- Prior assistant messages, tool results, and current state may be used only to resolve references such as "the first one" or "same dealer".
- List each patchable field and the exact extraction rule.
- Define when to leave a field unchanged.
- Define cancellation and confirmation wording precisely.
- Define date/time normalization, time zone, unit, and range assumptions when the procedure requires them.
- For selections, copy the full known object exactly from shown options or tool facts; never synthesize missing fields.
- Forbid final replies, connector calls, invented records, and internal labels.

Patch should reset lifecycle state only when the latest user message changes upstream business facts or explicitly cancels/confirms. It must not mark a command as ready from vague intent.

## Prefetch

Use `prefetch` only for baseline read-only facts that do not depend on newly patched state, usually keyed by stable session data such as `session.userId`.

Good prefetch inputs include customer profile, owned assets, current contract context, baseline permissions, or product catalogs that are valid before user-specific choices.

Keep prefetch output in runtime context unless the procedure says the fact must become durable workflow state. Isolate optional baseline failures when the procedure allows continuing without them.

## Effects

Effects perform deterministic, idempotent progression after patch.

Use effects to:

- Check readiness and set blockers.
- Resolve user facts against connector facts.
- Load candidates based on current state.
- Auto-select only when the procedure explicitly permits it.
- Prepare drafts that still need user confirmation.
- Add `ToolMessage` entries for facts render must see.

For each effect, define dependencies with `effect(name, ["field"], config)` when the step is driven by state fields. Put business guards at the top of `run`; effects do not use `when`. Return partial state and optional tool messages. Do not perform irreversible external mutations.

Wrap visible long work with `const loading = step.start("...")` and `loading.end(...)`.

Expose candidate facts to render with `ToolMessage`; import it from `@pac/workflow` only when the workflow returns tool messages:

```ts
effect("loadCandidates", ["need"], {
  description: "Reads candidate options for the current need; candidates are exposed to render and are not durable state.",
  run: async (state, context, _runtime, step) => {
    if (!state.need) return {};

    const loading = step.start("Reading options");
    const candidates = await context.call("connectors.example.searchCandidates", {
      need: state.need,
      limit: 3,
    }, { cache: true });
    loading.end({ count: candidates.length });

    return {
      messages: [
        new ToolMessage({
          name: "connectors.example.searchCandidates",
          call: { need: state.need, limit: 3 },
          result: candidates,
        }),
      ],
    };
  },
});
```

## Commands

Use `command` only for irreversible or externally mutating actions, such as submit, pay, book, cancel, or create a committed record.

A command must require explicit state evidence:

- Complete draft or selected option.
- Required user confirmation or consent.
- No existing committed record unless replacement is allowed.
- Required compliance or eligibility blockers cleared.

Command failure must not write a committed record. Ordinary preference changes must not erase committed records unless the procedure explicitly defines replacement/cancellation behavior.

## Render

Render is the only user-visible response path. It does not mutate state and does not call connectors.

Write render instructions as response policy:

- Use current state as authoritative.
- Use tool messages and prefetch facts as supporting evidence.
- Answer the user's latest follow-up before asking the next action.
- Ask the next smallest necessary question when required facts are missing.
- Present connector candidates as options, not selected facts.
- Explain blockers and no-result cases using procedure language.
- Show draft details and ask for confirmation before any command.
- Confirm committed outcomes from committed state or latest command tool result.
- Follow the procedure's compliance, safety, and tone requirements.
- Never expose JSON, state field names, workflow terms, connector syntax, tool-call markup, or internal labels.
- Never fabricate connector facts, availability, prices, ids, eligibility, or records.

Order render branches from terminal to earlier states:

1. Cancelled or completed committed outcome.
2. Command failure or blocking condition.
3. Draft ready and awaiting confirmation.
4. Candidate/options available and awaiting selection.
5. Missing user-provided facts.
6. General clarification or unsupported request within this procedure.

Keep replies concise unless the procedure requires detailed explanation.
