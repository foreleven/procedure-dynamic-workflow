import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineRouting } from "./builders.js";
import { workflow } from "./program.js";

const routing = defineRouting({
  examples: ["test workflow"],
  entities: ["test"],
  neighbors: [],
});

test("workflow program requires patch before render", () => {
  const program = createProgram("missing_patch");

  assert.throws(
    () => program.render({ name: "render", instruction: "Reply.", progress: "Rendering" }),
    /must declare patch before render/,
  );
});

test("workflow program rejects invalid workflow config invariants", () => {
  assert.throws(
    () =>
      workflow({
        id: " ",
        version: "0.1.0",
        description: "Invalid id fixture.",
        routing,
        stateSchema: z.object({ count: z.number() }),
        state: { count: 0 },
      }),
    /Workflow program id must be a non-empty string/,
  );
  assert.throws(
    () =>
      workflow({
        id: "bad_invalidation",
        version: "0.1.0",
        description: "Invalid invalidation fixture.",
        routing,
        stateSchema: z.object({ count: z.number() }),
        state: { count: 0 },
        invalidation: { count: [] },
      }),
    /Workflow bad_invalidation invalidation\.count must be an array of non-empty strings/,
  );
});

test("workflow program rejects duplicate node names", () => {
  const program = createProgram("duplicate_node");
  const effect = {
    progress: "Deriving state",
    description: "Increment count for test coverage.",
    when: () => true,
    run: () => ({ count: 1 }),
  };

  program.patch({ state: { count: z.number() } });
  program.derive("set_count", effect);

  assert.throws(
    () => program.command("set_count", effect),
    /Duplicate workflow node/,
  );
});

test("workflow program rejects invalid node config invariants", () => {
  const program = createProgram("bad_node_config");
  program.patch({ state: { count: z.number() } });

  assert.throws(
    () =>
      program.derive(" ", {
        progress: "Deriving state",
        description: "Invalid name fixture.",
        when: () => true,
        run: () => ({ count: 1 }),
      }),
    /Workflow bad_node_config node name must be a non-empty string/,
  );
  assert.throws(
    () =>
      program.derive("bad_progress", {
        progress: " ",
        description: "Invalid progress fixture.",
        when: () => true,
        run: () => ({ count: 1 }),
      }),
    /Workflow bad_node_config node bad_progress progress must be a non-empty string/,
  );
});

test("workflow program rejects duplicate patch declarations", () => {
  const program = createProgram("duplicate_patch");

  program.patch({ state: { count: z.number() } });

  assert.throws(
    () => program.patch({ state: { status: z.string().nullable() } }),
    /Workflow duplicate_patch already declared patch/,
  );
});

test("workflow program rejects invalid patch invalidates and render config", () => {
  const program = createProgram("bad_render_config");

  assert.throws(
    () =>
      program.patch({
        state: { count: z.number() },
        invalidates: { count: [] },
      }),
    /Workflow bad_render_config patch invalidates\.count must be an array of non-empty strings/,
  );

  const renderProgram = createProgram("bad_render_config");
  renderProgram.patch({ state: { count: z.number() } });
  assert.throws(
    () => renderProgram.render({ name: "render", instruction: "", progress: "Rendering" }),
    /Workflow bad_render_config render instruction must be a non-empty string/,
  );
});

test("workflow program compiles patch invalidation into the definition", () => {
  const program = createProgram("compiled_definition");

  program.patch({
    state: { count: z.number() },
    invalidates: { count: ["status"] },
  });
  program.derive("set_count", {
    progress: "Deriving state",
    description: "Increment count for test coverage.",
    when: () => true,
    run: (state) => ({ count: state.count + 1 }),
  });

  const definition = program.render({
    name: "render",
    instruction: "Reply.",
    progress: "Rendering",
  });

  assert.equal(definition.id, "compiled_definition");
  assert.equal(definition.nodes.length, 1);
  assert.deepEqual(definition.invalidation, { count: ["status"] });
});

function createProgram(id: string) {
  return workflow({
    id,
    version: "0.1.0",
    description: "Workflow program test fixture.",
    routing,
    stateSchema: z.object({
      count: z.number(),
      status: z.string().nullable(),
    }),
    state: {
      count: 0,
      status: null,
    },
  });
}
