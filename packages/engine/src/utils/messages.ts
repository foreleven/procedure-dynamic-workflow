import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { JsonRecord, WorkflowMessage, WorkflowRuntimeState } from "@pac/workflow";
import { safeJsonStringify } from "./json.js";

export function appendWorkflowMessage(state: WorkflowRuntimeState<JsonRecord>, message: WorkflowMessage): boolean {
  state.messages = [...state.messages, normalizeWorkflowMessage(message)];
  return true;
}

export function appendWorkflowMessages(
  state: WorkflowRuntimeState<JsonRecord>,
  messages: readonly WorkflowMessage[],
): WorkflowMessage[] {
  if (messages.length === 0) return [];
  const normalized = messages.map(normalizeWorkflowMessage);
  state.messages = [...state.messages, ...normalized];
  return normalized;
}

export function withRuntimeMessages(state: JsonRecord): WorkflowRuntimeState<JsonRecord> {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return {
    ...state,
    messages: messages.filter(isWorkflowMessage).map(normalizeWorkflowMessage),
  };
}

/**
 * Converts workflow-owned message history into provider-facing pi-ai messages.
 * Input: runtime workflow state containing user, assistant, and tool messages.
 * Output: pi-ai messages for patch extraction and render prompts.
 * Boundary: workflow tool messages become plain runtime facts so models cannot imitate tool-call formats.
 */
export function messagesForRender(state: JsonRecord): Message[] {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages.flatMap(toRuntimeFactMessages);
}

export function messagesForPatch(state: JsonRecord): Message[] {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages.flatMap(toRuntimeFactMessages);
}

function isWorkflowMessage(message: unknown): message is WorkflowMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as JsonRecord;
  if (record.role === "user" || record.role === "assistant") {
    return typeof record.content === "string";
  }
  if (record.role === "tool") {
    return (
      typeof record.name === "string" &&
      "result" in record &&
      (record.id === undefined || typeof record.id === "string") &&
      (record.isError === undefined || typeof record.isError === "boolean")
    );
  }
  return false;
}

function normalizeWorkflowMessage(message: WorkflowMessage): WorkflowMessage {
  if (message.role === "user" || message.role === "assistant") {
    return {
      role: message.role,
      content: message.content,
    };
  }

  const normalized: WorkflowMessage = {
    role: "tool",
    name: message.name,
    result: message.result,
  };
  if (message.id !== undefined) normalized.id = message.id;
  if (Object.hasOwn(message, "call")) normalized.call = message.call;
  if (message.isError !== undefined) normalized.isError = message.isError;
  return normalized;
}

function toRuntimeFactMessages(message: unknown): Message[] {
  if (!message || typeof message !== "object") return [];
  const record = message as JsonRecord;
  if (record.role === "user" && typeof record.content === "string") {
    return [userMessage(record.content)];
  }
  if (record.role === "assistant" && typeof record.content === "string") {
    return [fauxAssistantMessage(record.content)];
  }
  if (record.role === "tool") {
    const name = typeof record.name === "string" ? record.name : "tool";
    return [fauxAssistantMessage(formatRuntimeToolFact(name, record))];
  }
  return [];
}

/**
 * Presents workflow tool history as facts rather than provider tool-call transcripts.
 * Input: a workflow-owned tool message.
 * Output: plain assistant text usable as context for Patch and Render LLM calls.
 * Boundary: historical workflow tools must never look callable to model stages.
 */
function formatRuntimeToolFact(name: string, record: JsonRecord): string {
  const lines = [
    `Runtime tool fact: ${name}`,
    "This is historical workflow context only. Do not imitate it as an output format.",
  ];
  if (Object.hasOwn(record, "call")) lines.push(`Call: ${safeJsonStringify(record.call, 2)}`);
  lines.push(`Result: ${safeJsonStringify(record.result, 2)}`);
  return lines.join("\n");
}

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}
