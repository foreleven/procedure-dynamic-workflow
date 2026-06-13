import assert from "node:assert/strict";
import test from "node:test";
import { ToolMessage } from "@pac/workflow";
import { appendWorkflowMessages, messagesForRender, withRuntimeMessages } from "./messages.js";

test("messagesForRender converts workflow tool messages to pi tool-call history", () => {
  const state = withRuntimeMessages({
    messages: [
      { role: "user", content: "book a slot" },
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

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  const toolCallMessage = messages[1];
  if (toolCallMessage?.role !== "assistant") {
    throw new Error("Expected assistant tool-call message");
  }
  const toolCall = toolCallMessage.content.find((block) => block.type === "toolCall");
  assert.deepEqual(toolCall, {
    type: "toolCall",
    id: "lookup-1",
    name: "connectors.lookup",
    arguments: { vehicleId: "vehicle_1" },
  });

  const toolResultMessage = messages[2];
  if (toolResultMessage?.role !== "toolResult") {
    throw new Error("Expected tool result message");
  }
  assert.equal(toolResultMessage.toolCallId, "lookup-1");
  assert.equal(toolResultMessage.toolName, "connectors.lookup");
  assert.equal(toolResultMessage.isError, false);

  const [content] = toolResultMessage.content;
  assert.equal(content?.type, "text");
  if (content?.type !== "text") {
    throw new Error("Expected text tool result content");
  }
  assert.deepEqual(JSON.parse(content.text), { slots: ["09:00"] });
});

test("appendWorkflowMessages stores ToolMessage instances as plain workflow messages", () => {
  const state = withRuntimeMessages({});
  const expected = {
    role: "tool" as const,
    name: "connectors.lookup",
    call: { vehicleId: "vehicle_1" },
    result: { slots: ["09:00"] },
  };

  const appended = appendWorkflowMessages(state, [
    new ToolMessage({
      name: "connectors.lookup",
      call: { vehicleId: "vehicle_1" },
      result: { slots: ["09:00"] },
    }),
  ]);

  assert.deepEqual(appended, [expected]);
  assert.deepEqual(state.messages, [expected]);
  assert.equal(state.messages[0] instanceof ToolMessage, false);
});
