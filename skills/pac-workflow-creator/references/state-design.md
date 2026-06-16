# State Design

Design workflow state before writing connector calls or nodes. State is durable business truth across turns, not a scratchpad and not a mirror of tool parameters.

## Build State From Business Meaning

Start from the procedure:

- Business object and lifecycle: application, booking, claim, order, ticket, draft, committed record, cancellation, or completion.
- Facts the user can express directly: intent, preferences, quantities, date/time window, consent, selected option references.
- Facts that must survive across turns because they affect future decisions or render behavior.
- External facts that become durable only after a connector authoritatively returns them and the procedure says they matter.
- Terminal records from irreversible actions.

For every field, decide:

- Business meaning and source in the procedure.
- Zod type and default value.
- Writer: patch, prefetch, effect, or command.
- Invalidation rule when upstream state changes.
- Persistence rule, especially whether ordinary preference edits can clear it.
- Why this belongs in state instead of runtime context or a `ToolMessage`.

Use nullable fields for unknown business facts. Do not use `undefined` as business meaning. Never declare `messages`; it is reserved by the runtime.

## Do Not Aggregate Tool Parameters

Connector input schemas are integration boundaries. They are not a state design template.

When a tool takes many parameters, merge and trim them:

- Put session-owned values in connector input at call time, such as `userId`, tenant, locale, channel, auth scope, or current account. Do not store them in state unless the procedure lets the user choose or change them.
- Default operational parameters in the effect or command, such as `limit`, `pageSize`, `sort`, `includeInactive`, `source`, `currency`, `timezone`, or `dryRun`, when the procedure defines or implies a fixed value.
- Collapse related tool parameters into one business field when that is what the procedure means. Example: store `preferredWindow` in state, then expand it into `start`, `end`, and `timezone` for an availability tool.
- Ignore optional tool parameters that are not needed for the procedure. Do not expose future flexibility by adding state fields the user cannot meaningfully control.
- Ask for clarification only when a required tool parameter has no safe procedure-defined default and cannot be derived from state, context, or session.
- Keep candidate lists, search results, scoring payloads, and raw connector responses out of state; expose them to render through `ToolMessage`.

Examples:

- A product search tool accepts `amount`, `currency`, `termMonths`, `riskTier`, `limit`, and `sort`. If the procedure is USD-only and always shows three recommendations, state may store `requestedAmountCents` and `termMonths`; `currency: "USD"`, `limit: 3`, and `sort: "best_fit"` belong in the effect call, while `riskTier` comes from prefetch/customer context.
- An appointment tool accepts `dealerId`, `vehicleId`, `start`, `end`, `timezone`, and `includeLoaner`. State should store selected `dealer`, selected `vehicle`, and user `preferredWindow`; the effect expands the window and defaults `timezone` and `includeLoaner` if the procedure fixes them.
- A submit tool accepts many audit fields. State should store the confirmed draft and later the committed record. Audit fields are assembled by the command from session/runtime context, not persisted as user-facing state.

## Prefer These Fields

- `status` or `phase` for compact lifecycle progress.
- User-expressible facts and stable selections.
- Small selected refs copied from known connector facts when render or a later command needs them.
- Draft objects prepared before confirmation.
- Committed records returned by irreversible actions.
- Blocking or failure reason only when it changes future turns or render behavior.

Avoid:

- Candidate arrays, large connector payloads, raw external records, and derived display text.
- Boolean flags that hide the real business object, such as `submitted: true` without a committed record.
- One field per connector parameter when the procedure has a smaller business concept.
- State fields kept only to make one connector call easier.
- Clearing committed records on ordinary preference edits.

## Invalidation

Add invalidation immediately after state design.

- Clear downstream selections, drafts, estimates, and availability when upstream user-editable facts change.
- Clear generated drafts when any fact used to create the draft changes.
- Clear selected candidates when the search basis changes.
- Do not clear committed records unless the procedure explicitly defines replacement or cancellation.
- Prefer precise invalidation over resetting the whole state.

State is acceptable only when every field traces to a procedure rule, has one clear owner, and has a clear stale-data rule.
