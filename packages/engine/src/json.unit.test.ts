import assert from "node:assert/strict";
import test from "node:test";
import {
  safeJsonStringify,
  sameRuntimeValue,
} from "./utils/json.js";

test("safeJsonStringify serializes diagnostic values that JSON.stringify rejects", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const selfKeyedMap = new Map<unknown, unknown>();
  selfKeyedMap.set(selfKeyedMap, "self");
  const output = safeJsonStringify({
    circular,
    count: 1n,
    values: new Set(["a", "b"]),
    lookup: new Map([["key", "value"]]),
    selfKeyedMap,
  });

  assert.match(output, /"\[Circular\]"/);
  assert.match(output, /"count":"1"/);
  assert.match(output, /"values":\["a","b"\]/);
  assert.match(output, /"lookup":\{"key":"value"\}/);
});

test("safeJsonStringify does not mark shared references as circular", () => {
  const shared = { name: "shared" };
  const output = safeJsonStringify({
    first: shared,
    second: shared,
  });

  assert.doesNotMatch(output, /\[Circular\]/);
  assert.match(output, /"first":\{"name":"shared"\}/);
  assert.match(output, /"second":\{"name":"shared"\}/);
});

test("sameRuntimeValue treats non-serializable replacements as changed", () => {
  const left: { self?: unknown } = {};
  const right: { self?: unknown } = {};
  left.self = left;
  right.self = right;

  assert.equal(sameRuntimeValue({ nested: { ready: true } }, { nested: { ready: true } }), true);
  assert.equal(sameRuntimeValue(left, left), true);
  assert.equal(sameRuntimeValue(left, right), false);
  assert.equal(sameRuntimeValue({ count: 1n }, { count: 1n }), false);
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
