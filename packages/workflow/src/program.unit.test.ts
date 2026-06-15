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

test("workflow program type rejects reserved messages in author state", () => {
  if (false) {
    type StateWithMessages = {
      count: number;
      messages: string[];
    };

    workflow<StateWithMessages>({
      id: "reserved_messages_state",
      version: "0.1.0",
      description: "Compile-time fixture for reserved runtime state fields.",
      routing,
      stateSchema: z.object({
        count: z.number(),
        messages: z.array(z.string()),
      }),
      // @ts-expect-error messages is runtime-owned and must not be declared by workflow state.
      state: { count: 0, messages: [] },
    });
  }
});

test("workflow program rejects duplicate node names", () => {
  const program = createProgram("duplicate_node");
  const effect = {
    description: "Increment count for test coverage.",
    run: () => ({ count: 1 }),
  };
  const command = {
    description: "Increment count from command for duplicate coverage.",
    when: () => true,
    run: () => ({ count: 1 }),
  };

  program.patch({ state: { count: z.number() } });
  program.effect("set_count", effect);

  assert.throws(
    () => program.command("set_count", command),
    /Duplicate workflow node/,
  );
});

test("workflow program rejects invalid node config invariants", () => {
  const program = createProgram("bad_node_config");
  program.patch({ state: { count: z.number() } });

  assert.throws(
    () =>
      program.effect(" ", {
        description: "Invalid name fixture.",
        run: () => ({ count: 1 }),
      }),
    /Workflow bad_node_config node name must be a non-empty string/,
  );
  assert.throws(
    () =>
      program.effect("bad_description", {
        description: " ",
        run: () => ({ count: 1 }),
      }),
    /Workflow bad_node_config node bad_description description must be a non-empty string/,
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

test("workflow program compiles effect dependencies and patch invalidation into the definition", () => {
  const program = createProgram("compiled_definition");

  program.patch({
    state: { count: z.number() },
    invalidates: { count: ["status"] },
  });
  program.effect("set_count", ["count"], {
    description: "Increment count for test coverage.",
    run: (state) => ({ count: state.count + 1 }),
  });

  const definition = program.render({
    name: "render",
    instruction: "Reply.",
    progress: "Rendering",
  });

  assert.equal(definition.id, "compiled_definition");
  assert.equal(definition.nodes.length, 1);
  assert.deepEqual(definition.nodes[0]?.kind === "effect" ? definition.nodes[0].dependsOn : undefined, ["count"]);
  assert.deepEqual(definition.invalidation, { count: ["status"] });
});

test("workflow program keeps derive as an effect alias during migration", () => {
  const program = createProgram("derive_alias");

  program.patch({ state: { count: z.number() } });
  program.derive("set_count", {
    description: "Increment count for alias coverage.",
    dependsOn: ["count"],
    run: (state) => ({ count: state.count + 1 }),
  });

  const definition = program.render({
    name: "render",
    instruction: "Reply.",
    progress: "Rendering",
  });

  assert.equal(definition.nodes[0]?.kind, "effect");
  assert.deepEqual(definition.nodes[0]?.kind === "effect" ? definition.nodes[0].dependsOn : undefined, ["count"]);
});

test("workflow program rejects invalid effect dependencies", () => {
  const program = createProgram("bad_effect_dependencies");
  program.patch({ state: { count: z.number() } });

  assert.throws(
    () =>
      program.effect("bad_dependency", ["" as never], {
        description: "Invalid dependency fixture.",
        run: () => ({ count: 1 }),
      }),
    /dependsOn must contain only non-empty strings/,
  );
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
