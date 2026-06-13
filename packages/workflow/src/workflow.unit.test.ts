import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { definePatch, defineRouting, type PatchPolicy } from "./builders.js";
import {
  defineWorkflowDefinition,
  type WorkflowDefinition,
} from "./workflow.js";

const stateSchema = z.object({
  status: z.string(),
});

type DirectState = z.infer<typeof stateSchema>;

const routing = defineRouting({
  examples: ["direct workflow"],
  entities: ["direct"],
  neighbors: [],
});

const patch = definePatch({
  state: {
    status: z.string(),
  },
}) as PatchPolicy<unknown>;

test("defineWorkflowDefinition validates and returns direct definitions", () => {
  const definition = createDefinition();
  const result = defineWorkflowDefinition(definition);

  assert.equal(result, definition);
  assert.equal(result.id, "direct_flow");
});

test("defineWorkflowDefinition rejects malformed workflow metadata and routing", () => {
  assert.throws(
    () => defineWorkflowDefinition(null as never),
    /Workflow definition must be an object/,
  );
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), id: " " } as never),
    /Workflow definition id must be a non-empty string/,
  );
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), version: "" } as never),
    /Workflow direct_flow version must be a non-empty string/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        routing: { ...routing, entities: [" "] },
      } as never),
    /Workflow direct_flow routing\.entities must be an array of non-empty strings/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        routing: {
          ...routing,
          thresholds: { ...routing.thresholds, localAcept: 0.9 },
        },
      } as never),
    /Workflow direct_flow routing\.thresholds\.localAcept is not supported/,
  );
});

test("defineWorkflowDefinition rejects invalid default state and patch policy", () => {
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), stateSchema: {} } as never),
    /Workflow direct_flow stateSchema must provide parse/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        state: { status: "idle", messages: [] },
      } as never),
    /Workflow direct_flow default state must not define reserved messages field/,
  );
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), state: { status: 1 } } as never),
    /Workflow direct_flow default state does not satisfy stateSchema/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        patch: { ...patch, instruction: "" },
      } as never),
    /Workflow direct_flow patch\.instruction must be a non-empty string/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        patch: { ...patch, schema: {} },
      } as never),
    /Workflow direct_flow patch\.schema must provide parse/,
  );
});

test("defineWorkflowDefinition rejects malformed invalidation and nodes", () => {
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        invalidation: { status: [] },
      } as never),
    /Workflow direct_flow invalidation\.status must be an array of non-empty strings/,
  );
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), nodes: [] } as never),
    /Workflow direct_flow nodes must contain at least one node/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        nodes: [
          createNode("sync_status"),
          createNode("sync_status"),
        ],
      } as never),
    /Workflow direct_flow nodes contains duplicate node name: sync_status/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        nodes: [
          {
            ...createNode("bad_run"),
            run: "not-a-function",
          },
        ],
      } as never),
    /Workflow direct_flow nodes\[0\]\.bad_run run must be a function/,
  );
});

test("defineWorkflowDefinition rejects malformed render policies", () => {
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), render: null } as never),
    /Workflow direct_flow render must be a function or render policy/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        render: { name: "render", instruction: " ", progress: "Rendering" },
      } as never),
    /Workflow direct_flow render\.instruction must be a non-empty string/,
  );
});

function createDefinition(): WorkflowDefinition<DirectState, unknown> & {
  stateSchema: typeof stateSchema;
} {
  return {
    id: "direct_flow",
    version: "0.1.0",
    description: "Direct workflow definition test fixture.",
    routing,
    stateSchema,
    state: {
      status: "idle",
    },
    nodes: [
      createNode("sync_status"),
    ],
    patch,
    invalidation: {},
    render: ({ state }) => ({
      text: state.status,
    }),
  };
}

function createNode(name: string): WorkflowDefinition<DirectState, unknown>["nodes"][number] {
  return {
    kind: "effect",
    name,
    stage: "afterPatch",
    progress: "Syncing state",
    description: "Updates state for direct workflow definition coverage.",
    run: () => ({ state: { status: "ready" } }),
  };
}
