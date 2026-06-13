import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ROUTING_THRESHOLDS,
  definePatch,
  defineRouting,
} from "./builders.js";
import { z } from "zod";

test("defineRouting merges and validates routing thresholds", () => {
  const routing = defineRouting({
    examples: ["book maintenance"],
    entities: ["vehicle"],
    neighbors: [],
    thresholds: {
      localAccept: 0.9,
    },
  });

  assert.deepEqual(routing.thresholds, {
    ...DEFAULT_ROUTING_THRESHOLDS,
    localAccept: 0.9,
  });
});

test("defineRouting rejects invalid routing thresholds", () => {
  assert.throws(
    () => defineRouting(null as never),
    /routing must be an object/,
  );
  assert.throws(
    () =>
      defineRouting({
        examples: ["book maintenance"],
        entities: ["vehicle"],
        neighbors: [],
        thresholds: null as never,
      }),
    /routing\.thresholds must be an object/,
  );
  assert.throws(
    () =>
      defineRouting({
        examples: ["book maintenance"],
        entities: ["vehicle"],
        neighbors: [],
        thresholds: {
          localAcept: 0.9,
        } as never,
      }),
    /routing\.thresholds\.localAcept is not supported/,
  );
  assert.throws(
    () =>
      defineRouting({
        examples: ["book maintenance"],
        entities: ["vehicle"],
        neighbors: [],
        thresholds: {
          globalAccept: 1.5,
        },
      }),
    /routing\.thresholds\.globalAccept must be a finite number between 0 and 1/,
  );
});

test("defineRouting rejects blank routing terms", () => {
  assert.throws(
    () =>
      defineRouting({
        examples: ["book maintenance"],
        entities: ["   "],
        neighbors: [],
      }),
    /routing\.entities must be an array of non-empty strings/,
  );
});

test("definePatch rejects malformed state shapes and reserved fields", () => {
  assert.throws(
    () => definePatch(null as never),
    /patch config must be an object/,
  );
  assert.throws(
    () => definePatch({ state: null as never }),
    /patch state must be an object/,
  );
  assert.throws(
    () => definePatch({ state: { status: null as never } }),
    /patch state field status must be a Zod schema/,
  );
  assert.throws(
    () => definePatch({ state: { messages: z.array(z.string()) } }),
    /patch state field is reserved for runtime use: messages/,
  );
});

test("definePatch rejects malformed optional prompt metadata", () => {
  assert.throws(
    () => definePatch({ state: { status: z.string() }, model: "   " }),
    /patch model must be a non-empty string/,
  );
  assert.throws(
    () => definePatch({ state: { status: z.string() }, progress: 123 as never }),
    /patch progress must be a non-empty string/,
  );
  assert.throws(
    () => definePatch({ state: { status: z.string() }, instruction: "" }),
    /patch instruction must be a non-empty string/,
  );
});
