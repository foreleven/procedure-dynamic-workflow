import assert from "node:assert/strict";
import test from "node:test";
import { PrefetchStore, settlePrefetch } from "./prefetch.js";

test("settlePrefetch resolves fulfilled tasks and drops rejected or undefined results", async () => {
  const settled = await settlePrefetch({
    customer: Promise.resolve({ id: "customer_1" }),
    missing: undefined,
    failed: Promise.reject(new Error("connector unavailable")),
  });

  assert.deepEqual(settled, {
    customer: { id: "customer_1" },
  });
});

test("settlePrefetch rejects malformed task collections and keys", async () => {
  await assert.rejects(
    async () => settlePrefetch(null as never),
    /prefetch tasks must be an object/,
  );
  await assert.rejects(
    async () => settlePrefetch([] as never),
    /prefetch tasks must be an object/,
  );
  await assert.rejects(
    async () => settlePrefetch(Object.assign(new Map(), { customer: Promise.resolve("ok") }) as never),
    /prefetch tasks must be a plain object/,
  );
  await assert.rejects(
    async () => settlePrefetch({ "": Promise.resolve("ok") }),
    /prefetch task key must be a non-empty string/,
  );
});

test("PrefetchStore validates keys and merge objects", () => {
  const store = new PrefetchStore();

  store.set("customer", { id: "customer_1" });
  store.set("ignored", undefined);
  store.merge({ vehicle: { id: "vehicle_1" }, missing: undefined });

  assert.deepEqual(store.toJSON(), {
    customer: { id: "customer_1" },
    vehicle: { id: "vehicle_1" },
  });
  assert.throws(
    () => store.get(" "),
    /PrefetchStore key must be a non-empty string/,
  );
  assert.throws(
    () => store.set("", "bad"),
    /PrefetchStore key must be a non-empty string/,
  );
  assert.throws(
    () => store.merge([] as never),
    /PrefetchStore\.merge values must be an object/,
  );
  assert.throws(
    () => store.merge({ "": "bad" }),
    /PrefetchStore key must be a non-empty string/,
  );
});
