import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { definePatch, defineRouting, type PatchPolicy } from "./builders.js";
import { ToolMessage } from "./runtime/messages.js";
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

test("defineWorkflowDefinition asserts invariants and returns direct definitions", () => {
  const definition = createDefinition();
  const result = defineWorkflowDefinition(definition);

  assert.equal(result, definition);
  assert.equal(result.id, "direct_flow");
});

test("ToolMessage validates input and serializes to workflow message shape", () => {
  const message = new ToolMessage({
    id: "lookup-1",
    name: "connectors.lookup",
    call: { vehicleId: "vehicle_1" },
    result: { slots: ["09:00"] },
  });

  assert.deepEqual(message.toJSON(), {
    role: "tool",
    id: "lookup-1",
    name: "connectors.lookup",
    call: { vehicleId: "vehicle_1" },
    result: { slots: ["09:00"] },
  });
  assert.throws(
    () => new ToolMessage({ name: " ", result: {} }),
    /ToolMessage name must be a non-empty string/,
  );
});

test("defineWorkflowDefinition rejects invalid workflow metadata and routing invariants", () => {
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), id: " " }),
    /Workflow definition id must be a non-empty string/,
  );
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), version: "" }),
    /Workflow direct_flow version must be a non-empty string/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        routing: { ...routing, entities: [" "] },
      }),
    /Workflow direct_flow routing\.entities must be an array of non-empty strings/,
  );
  const thresholdsWithUnknownKey: typeof routing.thresholds = Object.assign(
    { ...routing.thresholds },
    { localAcept: 0.9 },
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        routing: {
          ...routing,
          thresholds: thresholdsWithUnknownKey,
        },
      }),
    /Workflow direct_flow routing\.thresholds\.localAcept is not supported/,
  );
});

test("defineWorkflowDefinition rejects invalid default state and patch policy", () => {
  const stateWithReservedField = { status: "idle", messages: [] };
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        state: stateWithReservedField,
      }),
    /Workflow direct_flow default state must not define reserved messages field/,
  );
  const strictStateSchema = z.object({
    status: z.string().min(5),
  });
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        stateSchema: strictStateSchema,
        state: { status: "idle" },
      }),
    /Workflow direct_flow default state does not satisfy stateSchema/,
  );
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        patch: { ...patch, instruction: "" },
      }),
    /Workflow direct_flow patch\.instruction must be a non-empty string/,
  );
});

test("defineWorkflowDefinition rejects invalid invalidation and node invariants", () => {
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        invalidation: { status: [] },
      }),
    /Workflow direct_flow invalidation\.status must be an array of non-empty strings/,
  );
  assert.throws(
    () => defineWorkflowDefinition({ ...createDefinition(), nodes: [] }),
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
      }),
    /Workflow direct_flow nodes contains duplicate node name: sync_status/,
  );
});

test("defineWorkflowDefinition rejects invalid render policy invariants", () => {
  assert.throws(
    () =>
      defineWorkflowDefinition({
        ...createDefinition(),
        render: { name: "render", instruction: " ", progress: "Rendering" },
      }),
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
