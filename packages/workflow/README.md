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
  defineRouting,
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
  id: "example",
  version: "0.1.0",
  description: "Example workflow.",
  routing: defineRouting({
    examples: ["run example"],
    entities: ["example"],
    neighbors: [],
  }),
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

## Public Surface

- `workflow(...)` builds workflow definitions from business steps.
- `definePatch(...)` creates structured patch extraction policies.
- `defineRouting(...)` normalizes routing metadata.
- `defineConnectorRef(...)`, `defineConnectorTool(...)`, and `createConnectorRegistry(...)` define schema-validated integration boundaries.
- `WorkflowContextStore` provides per-workflow runtime context for in-memory coordination.

See the repository [API reference](https://github.com/foreleven/procedure-dynamic-workflow/blob/main/docs/API.md) for the full public API reference.

## Status

This package is pre-1.0. Public APIs may change while the project is moving toward a stable open-source release.

## License

No open-source license has been selected yet. Do not treat this package as formally released until the repository includes an explicit `LICENSE` file.
