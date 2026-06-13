import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { definePatch, defineRouting } from "./builders.js";
import { defineWorkflowHooks } from "./hooks.js";

const routing = defineRouting({
  examples: ["hook workflow"],
  entities: ["hook"],
  neighbors: [],
});

const stateSchema = z.object({
  status: z.string(),
});

const patch = definePatch({
  state: {
    status: z.string(),
  },
});

test("defineWorkflowHooks builds a hook-based workflow definition", () => {
  const definition = defineWorkflowHooks({
    id: "hook_flow",
    version: "0.1.0",
    description: "Hook workflow test fixture.",
    routing,
    stateSchema,
    state: {
      status: "idle",
    },
    patch,
    invalidation: {},
    setup(hooks) {
      hooks.useEffect("mark_ready", () => ({ state: { status: "ready" } }), {
        progress: "Marking ready",
        description: "Marks state ready for hook workflow coverage.",
      });
      hooks.useRenderFunction(({ state }) => ({ text: state.status }));
    },
  });

  assert.equal(definition.id, "hook_flow");
  assert.equal(definition.nodes.length, 1);
  assert.equal(typeof definition.render, "function");
});

test("defineWorkflowHooks rejects invalid hook registration invariants", () => {
  assert.throws(
    () =>
      createHookWorkflow("blank_node", (hooks) => {
        hooks.useEffect(" ", () => undefined);
        hooks.useRenderFunction(() => ({ text: "ok" }));
      }),
    /Workflow node name must be a non-empty string/,
  );
  assert.throws(
    () =>
      createHookWorkflow("bad_progress", (hooks) => {
        hooks.useEffect("bad_progress_node", () => undefined, { progress: "" });
        hooks.useRenderFunction(() => ({ text: "ok" }));
      }),
    /Workflow node option progress must be a non-empty string/,
  );
  assert.throws(
    () =>
      createHookWorkflow("bad_stage", (hooks) => {
        hooks.useEffect("bad_stage_node", () => undefined, { stage: "later" as never });
        hooks.useRenderFunction(() => ({ text: "ok" }));
      }),
    /Workflow node option stage must be beforePatch, withPatch, or afterPatch/,
  );
  assert.throws(
    () =>
      createHookWorkflow("bad_when", (hooks) => {
        hooks.useEffect("bad_when_node", () => undefined, { when: "yes" as never });
        hooks.useRenderFunction(() => ({ text: "ok" }));
      }),
    /Workflow node option when must be a function/,
  );
  assert.throws(
    () =>
      createHookWorkflow("duplicate_render", (hooks) => {
        hooks.useEffect("ready", () => undefined);
        hooks.useRenderFunction(() => ({ text: "ok" }));
        hooks.useRenderFunction(() => ({ text: "ok" }));
      }),
    /Workflow duplicate_render registered render more than once/,
  );
  assert.throws(
    () =>
      createHookWorkflow("missing_render", (hooks) => {
        hooks.useEffect("ready", () => undefined);
      }),
    /Workflow missing_render did not register render/,
  );
});

function createHookWorkflow(
  id: string,
  setup: Parameters<typeof defineWorkflowHooks<typeof stateSchema, unknown>>[0]["setup"],
) {
  return defineWorkflowHooks({
    id,
    version: "0.1.0",
    description: "Hook workflow test fixture.",
    routing,
    stateSchema,
    state: {
      status: "idle",
    },
    patch,
    invalidation: {},
    setup,
  });
}
