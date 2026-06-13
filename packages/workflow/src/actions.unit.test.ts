import assert from "node:assert/strict";
import test from "node:test";
import {
  effectAction,
  hydrateContextAction,
  prefetchAction,
  renderAction,
  setContextAction,
  setStateAction,
} from "./actions.js";

interface ActionState {
  status: string;
}

test("workflow action helpers reject malformed configuration", () => {
  assert.throws(
    () => prefetchAction(null as never),
    /prefetch load must be a function/,
  );
  assert.throws(
    () => hydrateContextAction<ActionState, never>([]),
    /hydrateContext keys must be a non-empty string array/,
  );
  assert.throws(
    () => hydrateContextAction<ActionState, never>(["status", " "]),
    /hydrateContext keys must be a non-empty string array/,
  );
  assert.throws(
    () => setStateAction<ActionState, never, "status">(" " as "status", () => "ready"),
    /setState field must be a non-empty string/,
  );
  assert.throws(
    () => setStateAction<ActionState, never, "status">("status", null as never),
    /setState resolve must be a function/,
  );
  assert.throws(
    () => setContextAction<ActionState, never>(" ", () => "ready"),
    /setContext key must be a non-empty string/,
  );
  assert.throws(
    () => setContextAction<ActionState, never>("status", null as never),
    /setContext resolve must be a function/,
  );
  assert.throws(
    () => effectAction<ActionState, never>(null as never),
    /effect run must be a function/,
  );
  assert.throws(
    () => renderAction<ActionState, never>(null as never, { text: "fallback" }),
    /render cases must be an array/,
  );
  assert.throws(
    () => renderAction<ActionState, never>([{ text: "" }], { text: "fallback" }),
    /render cases\[0\]\.text must be a non-empty string/,
  );
  assert.throws(
    () => renderAction<ActionState, never>([], { text: "" }),
    /render fallback\.text must be a non-empty string/,
  );
});

test("renderAction accepts fallback-only render cases", async () => {
  const render = renderAction<ActionState, never>([], {
    text: ({ state }) => `status=${state.status}`,
    data: ({ state }) => ({ status: state.status }),
  });

  const result = await render({
    state: { status: "ready", messages: [] },
  } as never);

  assert.deepEqual(result, {
    text: "status=ready",
    data: { status: "ready" },
  });
});

test("renderAction rejects invalid dynamic text output", async () => {
  const input = {
    state: { status: "ready", messages: [] },
  } as never;

  await assert.rejects(
    async () => {
      await renderAction<ActionState, never>([], {
        text: () => 123 as never,
      })(input);
    },
    /render text result must be a non-empty string/,
  );

  await assert.rejects(
    async () => {
      await renderAction<ActionState, never>([], {
        text: () => " ",
      })(input);
    },
    /render text result must be a non-empty string/,
  );
});
