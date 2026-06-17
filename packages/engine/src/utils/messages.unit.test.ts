import assert from "node:assert/strict";
import test from "node:test";
import { ToolMessage } from "@pac/workflow";
import { appendWorkflowMessages, messagesForRender, withRuntimeMessages } from "./messages.js";

test("messagesForRender converts workflow tool messages to runtime fact text", () => {
  const state = withRuntimeMessages({
    messages: [
      { role: "user", content: "book a slot", timestamp: 1 },
      new ToolMessage({
        id: "lookup-1",
        name: "connectors.lookup",
        call: { vehicleId: "vehicle_1" },
        result: { slots: ["09:00"] },
      }),
      { role: "assistant", content: "Please choose a slot." },
    ],
  });

  const messages = messagesForRender(state);

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "assistant"]);
  const factMessage = messages[1];
  if (factMessage?.role !== "assistant") {
    throw new Error("Expected assistant runtime fact message");
  }

  const [content] = factMessage.content;
  assert.equal(content?.type, "text");
  if (content?.type !== "text") {
    throw new Error("Expected text runtime fact content");
  }
  assert.match(content.text, /Runtime tool fact: connectors\.lookup/);
  assert.match(content.text, /Id: lookup-1/);
  assert.match(content.text, /Do not imitate it as an output format/);
  assert.match(content.text, /"vehicleId": "vehicle_1"/);
  assert.match(content.text, /"slots": \[\s+"09:00"\s+\]/);
});

test("appendWorkflowMessages stores ToolMessage instances as plain workflow messages", () => {
  const state = withRuntimeMessages({});
  const expected = {
    role: "tool" as const,
    id: "lookup-1",
    name: "connectors.lookup",
    call: { vehicleId: "vehicle_1" },
    result: { slots: ["09:00"] },
  };

  const appended = appendWorkflowMessages(state, [
    new ToolMessage({
      id: "lookup-1",
      name: "connectors.lookup",
      call: { vehicleId: "vehicle_1" },
      result: { slots: ["09:00"] },
    }),
  ]);

  assert.deepEqual(appended, [expected]);
  assert.deepEqual(state.messages, [expected]);
  assert.equal(state.messages[0] instanceof ToolMessage, false);
});
