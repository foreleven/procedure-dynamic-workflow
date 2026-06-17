import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createConnectorRegistry, defineConnectorRef, defineConnectorTool } from "../connectors.js";
import { WorkflowContextStore } from "./context.js";

test("WorkflowContextStore caches connector calls by structural cache key", async () => {
  const lookupRef = defineConnectorRef({
    id: "connectors.lookup",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ query: z.string(), calls: z.number() }),
  });
  let calls = 0;
  const registry = createConnectorRegistry([
    defineConnectorTool(lookupRef, ({ query }) => {
      calls += 1;
      return { query, calls };
    }),
  ]);
  const context = new WorkflowContextStore(registry);

  const [first, second] = await Promise.all([
    context.call("connectors.lookup", { query: "alpha" }, { cacheKey: ["lookup", "alpha"] }),
    context.call("connectors.lookup", { query: "alpha" }, { cacheKey: ["lookup", "alpha"] }),
  ]);
  const repeated = await context.call("connectors.lookup", { query: "alpha" }, { cacheKey: ["lookup", "alpha"] });
  const next = await context.call("connectors.lookup", { query: "beta" }, { cacheKey: ["lookup", "beta"] });

  assert.equal(calls, 2);
  assert.strictEqual(second, first);
  assert.strictEqual(repeated, first);
  assert.deepEqual(next, { query: "beta", calls: 2 });
});

test("WorkflowContextStore caches connector calls with the default cache key", async () => {
  const lookupRef = defineConnectorRef({
    id: "connectors.defaultCached",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ query: z.string(), calls: z.number() }),
  });
  let calls = 0;
  const registry = createConnectorRegistry([
    defineConnectorTool(lookupRef, ({ query }) => {
      calls += 1;
      return { query, calls };
    }),
  ]);
  const context = new WorkflowContextStore(registry);

  const first = await context.call("connectors.defaultCached", { query: "alpha" }, { cache: true });
  const repeated = await context.call("connectors.defaultCached", { query: "alpha" }, { cache: true });
  const next = await context.call("connectors.defaultCached", { query: "beta" }, { cache: true });

  assert.equal(calls, 2);
  assert.strictEqual(repeated, first);
  assert.deepEqual(next, { query: "beta", calls: 2 });
});

test("WorkflowContextStore does not cache connector calls without a usable cache key", async () => {
  const lookupRef = defineConnectorRef({
    id: "connectors.uncached",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ calls: z.number() }),
  });
  let calls = 0;
  const registry = createConnectorRegistry([
    defineConnectorTool(lookupRef, () => {
      calls += 1;
      return { calls };
    }),
  ]);
  const context = new WorkflowContextStore(registry);

  await context.call("connectors.uncached", { query: "alpha" });
  await context.call("connectors.uncached", { query: "alpha" }, {});
  await context.call("connectors.uncached", { query: "alpha" }, { cacheKey: null });

  assert.equal(calls, 3);
});

test("WorkflowContextStore rejects default caching for non-JSON connector input", () => {
  const lookupRef = defineConnectorRef({
    id: "connectors.nonJsonInput",
    inputSchema: z.unknown(),
    outputSchema: z.object({ calls: z.number() }),
  });
  const registry = createConnectorRegistry([
    defineConnectorTool(lookupRef, () => ({ calls: 1 })),
  ]);
  const context = new WorkflowContextStore(registry);

  assert.throws(
    () => context.call("connectors.nonJsonInput", 1n, { cache: true }),
    /cache=true requires JSON-serializable input/,
  );
});

test("WorkflowContextStore drops rejected connector calls from the cache", async () => {
  const lookupRef = defineConnectorRef({
    id: "connectors.flaky",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ calls: z.number() }),
  });
  let calls = 0;
  const registry = createConnectorRegistry([
    defineConnectorTool(lookupRef, () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient connector failure");
      }
      return { calls };
    }),
  ]);
  const context = new WorkflowContextStore(registry);

  await assert.rejects(
    context.call("connectors.flaky", { query: "alpha" }, { cacheKey: ["lookup", "alpha"] }),
    /transient connector failure/,
  );
  const retry = await context.call("connectors.flaky", { query: "alpha" }, { cacheKey: ["lookup", "alpha"] });
  const repeated = await context.call("connectors.flaky", { query: "alpha" }, { cacheKey: ["lookup", "alpha"] });

  assert.equal(calls, 2);
  assert.deepEqual(retry, { calls: 2 });
  assert.strictEqual(repeated, retry);
});

test("WorkflowContextStore restores checkpointed runtime values and connector cache", async () => {
  const lookupRef = defineConnectorRef({
    id: "connectors.checkpoint",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ calls: z.number() }),
  });
  let calls = 0;
  const registry = createConnectorRegistry([
    defineConnectorTool(lookupRef, () => {
      calls += 1;
      return { calls };
    }),
  ]);
  const context = new WorkflowContextStore(registry);
  const runtimeValue = () => "kept";

  context.set("runtime", runtimeValue);
  context.ack({
    id: "confirm",
    prompt: "Continue?",
    options: [{ id: "yes", label: "Yes" }],
  });
  const first = await context.call("connectors.checkpoint", { query: "alpha" }, { cacheKey: ["alpha"] });
  const checkpoint = context.checkpoint();

  context.set("runtime", () => "changed");
  context.set("temporary", "drop");
  context.clearAck();
  await context.call("connectors.checkpoint", { query: "beta" }, { cacheKey: ["beta"] });
  context.restore(checkpoint);
  const repeated = await context.call("connectors.checkpoint", { query: "alpha" }, { cacheKey: ["alpha"] });
  const beta = await context.call("connectors.checkpoint", { query: "beta" }, { cacheKey: ["beta"] });

  assert.strictEqual(context.get("runtime"), runtimeValue);
  assert.equal(context.has("temporary"), false);
  assert.equal(context.getAck()?.id, "confirm");
  assert.strictEqual(repeated, first);
  assert.deepEqual(beta, { calls: 3 });
  assert.equal(calls, 3);
});
