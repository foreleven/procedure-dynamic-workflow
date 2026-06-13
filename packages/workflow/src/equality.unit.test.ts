import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorRegistry } from "./connectors.js";
import { sameRuntimeValue } from "./equality.js";
import { WorkflowContextStore } from "./workflow.js";

test("sameRuntimeValue treats non-serializable values as changed instead of throwing", () => {
  const left: { self?: unknown } = {};
  const right: { self?: unknown } = {};
  left.self = left;
  right.self = right;

  assert.equal(sameRuntimeValue({ nested: { ready: true } }, { nested: { ready: true } }), true);
  assert.equal(sameRuntimeValue(left, right), false);
  assert.equal(sameRuntimeValue({ value: 1n }, { value: 1n }), false);
  assert.equal(sameRuntimeValue(new Map([["key", "left"]]), new Map([["key", "right"]])), false);
  assert.equal(sameRuntimeValue(new Set(["left"]), new Set(["right"])), false);
  assert.equal(sameRuntimeValue(new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z")), false);
  assert.equal(sameRuntimeValue({ value: undefined }, {}), false);

  const sparse = Array<string | undefined>(1);
  assert.equal(sameRuntimeValue(sparse, [undefined]), false);
});

test("sameRuntimeValue compares JSON object keys structurally", () => {
  assert.equal(
    sameRuntimeValue(
      { nested: { first: "a", second: "b" }, items: [{ id: "one", value: 1 }] },
      { items: [{ value: 1, id: "one" }], nested: { second: "b", first: "a" } },
    ),
    true,
  );
  assert.equal(sameRuntimeValue({ nested: { first: "a" } }, { nested: { first: "b" } }), false);
});

test("WorkflowContextStore accepts non-serializable runtime values", () => {
  const context = new WorkflowContextStore(createConnectorRegistry());
  const first: { self?: unknown } = {};
  const second: { self?: unknown } = {};
  first.self = first;
  second.self = second;

  assert.doesNotThrow(() => context.set("runtime", first));
  assert.equal(context.revision, 1);

  context.set("runtime", first);
  assert.equal(context.revision, 1);

  assert.doesNotThrow(() => context.set("runtime", second));
  assert.equal(context.revision, 2);
  assert.equal(context.get("runtime"), second);
});

test("WorkflowContextStore treats runtime object replacements as changes", () => {
  const context = new WorkflowContextStore(createConnectorRegistry());

  context.set("lookup", new Map([["key", "left"]]));
  context.set("lookup", new Map([["key", "right"]]));

  assert.equal(context.revision, 2);
});

test("WorkflowContextStore ignores JSON object key ordering", () => {
  const context = new WorkflowContextStore(createConnectorRegistry());

  context.set("filters", { first: "a", second: "b" });
  context.set("filters", { second: "b", first: "a" });

  assert.equal(context.revision, 1);
});
