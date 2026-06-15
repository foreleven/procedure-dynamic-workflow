import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type {
  JsonRecord,
  WorkflowAssistantMessage,
  WorkflowMessage,
  WorkflowRuntimeState,
  WorkflowToolMessage,
  WorkflowUserMessage,
} from "@pac/workflow";
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

export function copyWorkflowMessages(messages: readonly WorkflowMessage[]): WorkflowMessage[] {
  return [...messages];
}

export function normalizeWorkflowMessages(messages: readonly WorkflowMessage[]): WorkflowMessage[] {
  return messages.map(normalizeWorkflowMessage);
}

export function withRuntimeMessages(
  state: JsonRecord,
  runtimeMessages?: readonly WorkflowMessage[],
): WorkflowRuntimeState<JsonRecord> {
  if (runtimeMessages !== undefined) {
    return {
      ...state,
      messages: copyWorkflowMessages(runtimeMessages),
    };
  }

  const storedMessages = Array.isArray(state.messages) ? state.messages : [];
  return {
    ...state,
    messages: storedMessages.filter(isWorkflowMessage).map(normalizeWorkflowMessage),
  };
}

/**
 * Converts workflow-owned message history into provider-facing pi-ai messages.
 * Input: runtime workflow state containing user, assistant, and tool messages.
 * Output: pi-ai messages for patch extraction and render prompts.
 * Boundary: workflow tool messages become plain runtime facts so models cannot imitate tool-call formats.
 */
export function messagesForRender(state: WorkflowRuntimeState<JsonRecord>): Message[] {
  return messagesForWorkflowMessages(state.messages);
}

export function messagesForPatch(state: WorkflowRuntimeState<JsonRecord>): Message[] {
  return messagesForWorkflowMessages(state.messages);
}

/**
 * Converts an already assembled workflow message log into provider messages.
 * Input: session-owned or workflow-local runtime message history.
 * Output: provider-facing pi-ai messages preserving user/assistant metadata and tool facts.
 * Boundary: this does not read or mutate workflow state; callers own message ordering.
 */
export function messagesForWorkflowMessages(messages: readonly WorkflowMessage[]): Message[] {
  return messages.flatMap(toRuntimeFactMessages);
}

function isWorkflowMessage(message: unknown): message is WorkflowMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as JsonRecord;
  if (record.role === "user" || record.role === "assistant") {
    return typeof record.content === "string" && (record.id === undefined || typeof record.id === "string");
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
      ...definedFields(message),
      role: message.role,
      content: message.content,
    };
  }

  const normalized: WorkflowMessage = {
    ...definedFields(message),
    role: "tool",
    name: message.name,
    result: message.result,
  };
  if (message.id !== undefined) normalized.id = message.id;
  if (Object.hasOwn(message, "call")) normalized.call = message.call;
  if (message.isError !== undefined) normalized.isError = message.isError;
  return normalized;
}

function definedFields(message: WorkflowMessage): JsonRecord {
  return Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined));
}

function toRuntimeFactMessages(message: WorkflowMessage): Message[] {
  if (message.role === "user") {
    return [userMessage(message)];
  }
  if (message.role === "assistant") {
    return [assistantMessage(message)];
  }
  return [fauxAssistantMessage(formatRuntimeToolFact(message))];
}

/**
 * Presents workflow tool history as facts rather than provider tool-call transcripts.
 * Input: a workflow-owned tool message.
 * Output: plain assistant text usable as context for Patch and Render LLM calls.
 * Boundary: historical workflow tools must never look callable to model stages.
 */
function formatRuntimeToolFact(message: WorkflowToolMessage): string {
  const lines = [
    `Runtime tool fact: ${message.name}`,
    "This is historical workflow context only. Do not imitate it as an output format.",
  ];
  if (message.id !== undefined) lines.push(`Id: ${message.id}`);
  if (Object.hasOwn(message, "call")) lines.push(`Call: ${safeJsonStringify(message.call, 2)}`);
  lines.push(`Result: ${safeJsonStringify(message.result, 2)}`);
  return lines.join("\n");
}

function userMessage(input: string | WorkflowUserMessage): Message {
  const timestamp = typeof input === "string" ? undefined : numberField(input, "timestamp");
  return {
    role: "user",
    content: typeof input === "string" ? input : input.content,
    timestamp: timestamp ?? Date.now(),
  };
}

function assistantMessage(message: WorkflowAssistantMessage): Message {
  const textSignature = stringField(message, "textSignature") ?? message.id;
  const responseId = stringField(message, "responseId");
  const timestamp = numberField(message, "timestamp");
  return fauxAssistantMessage(
    textSignature === undefined
      ? message.content
      : { type: "text", text: message.content, textSignature },
    {
      ...(responseId === undefined ? {} : { responseId }),
      ...(timestamp === undefined ? {} : { timestamp }),
    },
  );
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
