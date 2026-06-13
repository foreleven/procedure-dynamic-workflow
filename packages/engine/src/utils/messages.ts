import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { JsonRecord, WorkflowMessage, WorkflowRuntimeState } from "@pac/workflow";
import { safeJsonStringify } from "./json.js";

export function appendWorkflowMessage(state: WorkflowRuntimeState<JsonRecord>, message: WorkflowMessage): boolean {
  state.messages = [...state.messages, message];
  return true;
}

export function appendWorkflowMessages(
  state: WorkflowRuntimeState<JsonRecord>,
  messages: readonly WorkflowMessage[],
): WorkflowMessage[] {
  if (messages.length === 0) return [];
  state.messages = [...state.messages, ...messages];
  return [...messages];
}

export function withRuntimeMessages(state: JsonRecord): WorkflowRuntimeState<JsonRecord> {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return {
    ...state,
    messages: messages.filter(isWorkflowMessage),
  };
}

/**
 * Converts workflow-owned message history into provider-facing pi-ai messages.
 * Input: runtime workflow state containing user, assistant, and tool messages.
 * Output: pi-ai messages safe for patch extraction and rendering prompts.
 * Boundary: tool messages are represented as synthetic user text because provider adapters do not own workflow tool calls.
 */
export function messagesForRender(state: JsonRecord): Message[] {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages
    .map(toPiMessage)
    .filter((message): message is Message => Boolean(message));
}

export function messagesForPatch(state: JsonRecord): Message[] {
  return messagesForRender(state);
}

function isWorkflowMessage(message: unknown): message is WorkflowMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as JsonRecord;
  if (record.role === "user" || record.role === "assistant") {
    return typeof record.content === "string";
  }
  if (record.role === "tool") {
    return typeof record.name === "string" && "result" in record;
  }
  return false;
}

function toPiMessage(message: unknown): Message | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as JsonRecord;
  if (record.role === "user" && typeof record.content === "string") {
    return userMessage(record.content);
  }
  if (record.role === "assistant" && typeof record.content === "string") {
    return fauxAssistantMessage(record.content);
  }
  if (record.role === "tool") {
    const name = typeof record.name === "string" ? record.name : "tool";
    return userMessage(
      `Tool ${name} result:\n${safeJsonStringify({
        call: record.call,
        result: record.result,
      }, 2)}`,
    );
  }
  return undefined;
}

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}
