import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowId } from "@pac/workflow";
import {
  applyObjectPatch,
  applySessionPatch,
  normalizeMessagePatch,
} from "./patching.js";
import type { EngineSession } from "./types.js";

test("normalizeMessagePatch preserves null state fields and drops undefined/reserved fields", () => {
  const patch = normalizeMessagePatch({
    sessionPatch: {
      facts: { locale: "zh-CN" },
      preferences: null,
      goals: ["book maintenance"],
      constraints: ["morning only"],
    },
    statePatch: {
      vehicleId: "vehicle_1",
      dealerId: null,
      slotId: undefined,
      messages: [{ role: "assistant", content: "replace history" }],
    },
  });

  assert.deepEqual(patch, {
    sessionPatch: {
      facts: { locale: "zh-CN" },
      goals: ["book maintenance"],
      constraints: ["morning only"],
    },
    statePatch: {
      vehicleId: "vehicle_1",
      dealerId: null,
    },
  });
});

test("applySessionPatch merges records and de-duplicates list fields", () => {
  const session = createSession();

  applySessionPatch(session, {
    facts: { city: "Shanghai" },
    preferences: { language: "zh-CN" },
    goals: ["existing goal", "new goal"],
    constraints: ["weekday"],
  });

  assert.deepEqual(session.facts, { tier: "gold", city: "Shanghai" });
  assert.deepEqual(session.preferences, { language: "zh-CN" });
  assert.deepEqual(session.goals, ["existing goal", "new goal"]);
  assert.deepEqual(session.constraints, ["weekday"]);
});

test("applyObjectPatch returns only fields with semantic changes", () => {
  const target = {
    count: 1,
    dealerId: "dealer_1",
    messages: [{ role: "user", content: "keep history" }],
    nested: { ready: true },
    reordered: { first: "a", second: "b" },
  };

  const dirtyFields = applyObjectPatch(target, {
    count: 1,
    messages: [{ role: "assistant", content: "replace history" }],
    dealerId: null,
    nested: { ready: true },
    reordered: { second: "b", first: "a" },
    status: "confirmed",
  });

  assert.deepEqual(dirtyFields, ["dealerId", "status"]);
  assert.deepEqual(target, {
    count: 1,
    dealerId: null,
    messages: [{ role: "user", content: "keep history" }],
    nested: { ready: true },
    reordered: { first: "a", second: "b" },
    status: "confirmed",
  });
});

test("applyObjectPatch treats non-serializable replacements as changes instead of throwing", () => {
  const first: { self?: unknown } = {};
  const second: { self?: unknown } = {};
  first.self = first;
  second.self = second;
  const target = {
    circular: first,
    counter: { value: 1n },
    lookup: new Map([["key", "left"]]),
  };

  assert.deepEqual(applyObjectPatch(target, { circular: first }), []);
  assert.deepEqual(
    applyObjectPatch(target, {
      circular: second,
      counter: { value: 1n },
      lookup: new Map([["key", "right"]]),
    }),
    ["circular", "counter", "lookup"],
  );
  assert.equal(target.circular, second);
  assert.deepEqual(target.counter, { value: 1n });
  assert.deepEqual([...target.lookup.entries()], [["key", "right"]]);
});

function createSession(): EngineSession {
  return {
    sessionId: "session_test",
    userId: "user_test",
    activeWorkflowIds: [] as WorkflowId[],
    messages: [],
    facts: { tier: "gold" },
    preferences: {},
    goals: ["existing goal"],
    constraints: [],
    sharedCache: new Map<string, unknown>(),
    routingMemory: { lastMatchedWorkflowIds: [] },
  };
}
