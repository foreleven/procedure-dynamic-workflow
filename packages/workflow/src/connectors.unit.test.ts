import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  createConnectorRegistry,
  defineConnectorCatalog,
  defineConnectorRef,
  defineConnectorTool,
} from "./connectors.js";

const addRef = defineConnectorRef({
  id: "math.add",
  inputSchema: z.object({
    left: z.number(),
    right: z.number(),
  }),
  outputSchema: z.object({
    sum: z.number(),
  }),
});

test("ConnectorRegistry validates connector input and output", async () => {
  const registry = createConnectorRegistry([
    defineConnectorTool(addRef, ({ left, right }) => ({ sum: left + right })),
  ]);

  await assert.doesNotReject(async () => {
    assert.deepEqual(await registry.call("math.add", { left: 2, right: 3 }), { sum: 5 });
  });

  await assert.rejects(
    registry.call("math.add", { left: "2", right: 3 } as never),
    isZodError,
  );
});

test("ConnectorRegistry rejects connector outputs that do not match the catalog schema", async () => {
  const registry = createConnectorRegistry([
    defineConnectorTool(addRef, () => ({ sum: "5" } as never)),
  ]);

  await assert.rejects(
    registry.call("math.add", { left: 2, right: 3 }),
    isZodError,
  );
});

test("defineConnectorCatalog requires catalog keys to match connector ids", () => {
  assert.throws(
    () => defineConnectorCatalog({ wrong: addRef }),
    /Connector catalog key must match connector id/,
  );
});

test("connector definition helpers reject malformed contracts early", () => {
  assert.throws(
    () => defineConnectorRef(null as never),
    /Connector ref must be an object/,
  );
  assert.throws(
    () =>
      defineConnectorRef({
        id: " ",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
      }),
    /Connector ref id must be a non-empty string/,
  );
  assert.throws(
    () =>
      defineConnectorRef({
        id: "bad.description",
        description: 123,
        inputSchema: z.object({}),
        outputSchema: z.object({}),
      } as never),
    /Connector ref description must be a non-empty string/,
  );
  assert.throws(
    () =>
      defineConnectorRef({
        id: "blank.description",
        description: " ",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
      }),
    /Connector ref description must be a non-empty string/,
  );
  assert.throws(
    () =>
      defineConnectorRef({
        id: "bad.input",
        inputSchema: {},
        outputSchema: z.object({}),
      } as never),
    /Connector ref inputSchema must provide parse/,
  );
  assert.throws(
    () => defineConnectorTool(addRef, null as never),
    /Connector tool math\.add execute must be a function/,
  );
  assert.throws(
    () => defineConnectorTool(null as never, () => undefined),
    /Connector ref must be an object/,
  );
  assert.throws(
    () => defineConnectorCatalog(null as never),
    /Connector catalog must be an object/,
  );
  assert.throws(
    () => defineConnectorCatalog({ "math.add": { ...addRef, outputSchema: {} } as never }),
    /Connector catalog entry math\.add outputSchema must provide parse/,
  );
});

test("ConnectorRegistry rejects duplicate tools and incomplete catalogs", () => {
  const tool = defineConnectorTool(addRef, ({ left, right }) => ({ sum: left + right }));

  assert.throws(
    () => createConnectorRegistry([tool, tool]),
    /Duplicate connector tool/,
  );

  assert.throws(
    () => createConnectorRegistry([], { "math.add": addRef }),
    /Missing connector tool for catalog entry/,
  );

  assert.throws(
    () => createConnectorRegistry(null as never),
    /ConnectorRegistry tools must be an array/,
  );

  assert.throws(
    () => createConnectorRegistry([], [] as never),
    /Connector catalog must be an object/,
  );
});

test("ConnectorRegistry rejects malformed connector contracts during construction", () => {
  const tool = defineConnectorTool(addRef, ({ left, right }) => ({ sum: left + right }));

  assert.throws(
    () =>
      createConnectorRegistry([
        {
          ...tool,
          inputSchema: {},
        } as never,
      ]),
    /inputSchema must provide parse/,
  );

  assert.throws(
    () =>
      createConnectorRegistry([tool], {
        "math.add": {
          ...addRef,
          outputSchema: {},
        } as never,
      }),
    /outputSchema must provide parse/,
  );

  assert.throws(
    () => createConnectorRegistry([tool], { wrong: addRef }),
    /Connector catalog key must match connector id/,
  );
});

function isZodError(error: unknown): boolean {
  return error instanceof z.ZodError;
}
