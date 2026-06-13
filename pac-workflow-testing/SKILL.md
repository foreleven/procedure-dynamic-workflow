---
name: pac-workflow-testing
description: Build deterministic PAC workflow scenario tests that verify workflow metadata, connector wiring, runtime state transitions, command guards, invalidation, and 100% workflow.yaml business-case coverage.
---

# PAC Workflow Testing

Use this skill when a user asks to test a PAC workflow, validate a generated workflow, or prove business scenario coverage.

## Testing Model

Workflow tests have two layers:

- Deterministic runtime verification: a fake structured LLM returns schema-valid state patches so tests can focus on workflow semantics, connector wiring, invalidation, and command boundaries.
- Optional manual LLM scenario runs: real model extraction and render quality are checked separately because responses can vary.

The required quality gate for generated scenarios is deterministic runtime verification with 100% `workflow.yaml` case coverage.

## Workflow

1. Read the procedure, `workflow.yaml`, workflow file, connectors, and mock data.
2. Parse `workflow.yaml` with a schema that includes all declared `cases`.
3. Verify static wiring:
   - workflow id/version/description/routing match metadata
   - case ids are unique
   - cases reference known mock users or accounts
   - connector catalog ids match registered connector tools
   - every `context.call("...")` id in workflow source is registered
4. Verify mock data consistency:
   - no dangling references
   - products/options used in cases exist
   - boundary fixtures for missing data and failures exist
5. Build a deterministic engine per runtime path:
   - inject the workflow artifact
   - inject the scenario connector registry
   - inject a scripted LLM that returns queued `statePatch` objects
   - inject a fixed clock for relative-date or time-sensitive behavior
6. For each business case, run the user turns and assert state, context, tool messages, and command results.
7. Add extra runtime paths for important failure and boundary conditions, especially:
   - missing prerequisite data
   - user changes upstream decisions
   - follow-up questions that must not trigger commands
   - prefetch connector failure isolation where applicable
   - command connector failure behavior
8. Compute coverage as:
   - `covered workflow.yaml case ids / declared workflow.yaml case ids`
   - fail if any declared case is not mapped to a deterministic runtime path
   - print `100% business case coverage` only when the sets match exactly

## Script Rules

- Keep verifier scripts standalone and runnable with `tsx`.
- Use small assertion helpers instead of bringing in a test framework unless the repo already has one for scenario checks.
- Add comments to verifier helpers explaining input, output, and boundary.
- Do not use real LLM calls in deterministic scenario checks.
- Do not swallow command failures unless the workflow explicitly models a recoverable error state.
- Prefer checking workflow state and connector side effects over brittle response text.

## Done Criteria

A workflow scenario passes Testing only when:

- metadata, connector, and fixture checks pass
- every declared business case is executed by deterministic runtime tests
- upstream-change invalidation is tested
- irreversible commands require explicit state evidence
- command failure does not create committed records
- the script reports 100% business case coverage
