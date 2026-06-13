import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
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
 * Output: pi-ai messages safe for patch extraction and rendering prompts.
 * Boundary: workflow tool messages become paired pi assistant toolCall and toolResult messages.
 */
export function messagesForRender(state: JsonRecord): Message[] {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  return messages.flatMap(toPiMessages);
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

function toPiMessages(message: unknown, index: number): Message[] {
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
    const toolCallId = toolCallIdFor(record, index, name);
    return [
      fauxAssistantMessage(
        fauxToolCall(name, toolArguments(record.call), { id: toolCallId }),
        { stopReason: "toolUse" },
      ),
      toolResultMessage(toolCallId, name, record.result, record.isError === true),
    ];
  }
  return [];
}

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{
      type: "text",
      text: safeJsonStringify(result, 2),
    }],
    isError,
    timestamp: Date.now(),
  };
}

function toolArguments(call: unknown): Record<string, unknown> {
  if (call === undefined) return {};
  if (isPlainRecord(call)) return call;
  return { input: call };
}

function toolCallIdFor(record: JsonRecord, index: number, name: string): string {
  if (typeof record.id === "string" && record.id.trim().length > 0) return record.id;
  const normalizedName = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
  return `workflow-tool-${index}-${normalizedName.slice(0, 48)}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
