# @pac/workflow

Workflow DSL, connector contracts, schemas, and runtime types for PAC dynamic workflows.

## Install

Requires Node.js `>=24.0.0`.

```bash
npm install @pac/workflow
```

## Usage

```ts
import {
  createConnectorRegistry,
  defineConnectorRef,
  defineConnectorTool,
  workflow,
  z,
} from "@pac/workflow";

const lookupUser = defineConnectorRef({
  id: "users.lookup",
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: z.object({ name: z.string() }),
});

export const connectors = createConnectorRegistry([
  defineConnectorTool(lookupUser, async ({ userId }) => ({ name: userId })),
]);

const program = workflow({
  stateSchema: z.object({
    userId: z.string().nullable(),
  }),
  state: {
    userId: null,
  },
});

program.patch({
  state: {
    userId: z.string().nullable(),
  },
});

export default program.render({
  name: "example_render",
  instruction: "Reply with the next user-facing message.",
  progress: "Rendering reply",
});
```

When a workflow file is loaded through an agent manifest, `agent.yaml` supplies the stable `id`, `version`, `description`, and `routing` metadata. Standalone modules can still pass those fields directly to `workflow(...)` and export a complete workflow definition.

## Public Surface

- `workflow(...)` builds manifest-backed workflow templates or complete workflow definitions from `patch`, `prefetch`, `effect`, `command`, and `render` business steps.
- `definePatch(...)` creates structured patch extraction policies.
- `defineRouting(...)` normalizes routing metadata.
- `defineConnectorRef(...)`, `defineConnectorTool(...)`, and `createConnectorRegistry(...)` define schema-validated integration boundaries.
- `WorkflowContextStore` provides per-workflow runtime context for in-memory coordination, optional cached connector calls through `context.call(id, input, { cache: true })`, and same-process checkpoint/restore used by the engine's turn rollback.
- `WorkflowStepController` lets effect and command callbacks emit nested loading steps while async connector work is running.

See the repository [API reference](https://github.com/foreleven/procedure-dynamic-workflow/blob/main/docs/API.md) for the full public API reference.

## Status

This package is pre-1.0. Public APIs may change while the project is moving toward a stable open-source release.

## License

No open-source license has been selected yet. Do not treat this package as formally released until the repository includes an explicit `LICENSE` file.
