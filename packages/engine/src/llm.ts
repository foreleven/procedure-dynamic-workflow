import {
  complete,
  getModel,
  stream,
  type AssistantMessage,
  type Message,
  type Model,
  type Tool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { safeJsonStringify } from "./utils/json.js";

export type LlmTextRequest = {
  name?: string | undefined;
  model?: string | undefined;
  instruction: string;
  messages: Message[];
};

export type LlmStructuredRequest<TSchema extends z.ZodType> = {
  name: string;
  model?: string | undefined;
  instruction: string;
  schema: TSchema;
  messages: Message[];
};

export type LlmUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type LlmTextStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; text: string; usage?: LlmUsage | undefined };

export interface LlmClient {
  text(request: LlmTextRequest): Promise<string>;
  streamText?(request: LlmTextRequest): AsyncIterable<LlmTextStreamEvent>;
  structured<TSchema extends z.ZodType>(
    request: LlmStructuredRequest<TSchema>,
  ): Promise<z.infer<TSchema>>;
}

type PiAiOpenAiModel = Model<"openai-completions">;

const DEFAULT_MODEL = "deepseek-v4-flash";

export interface LlmClientOptions {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  defaultModel?: string | undefined;
  model?: PiAiOpenAiModel | undefined;
  logger?: ((line: string) => void) | undefined;
}

export function createLlmClient(options: LlmClientOptions = {}): LlmClient {
  validateLlmClientOptions(options);
  return new PiAiLlmClient(options);
}

class PiAiLlmClient implements LlmClient {
  private readonly apiKey: string | undefined;
  private readonly baseModel: PiAiOpenAiModel;
  private readonly logger: ((line: string) => void) | undefined;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey;
    const model = createBaseModel(options);
    this.baseModel = options.model ?? model;
    this.logger = options.logger;
  }

  /**
   * Runs plain assistant text generation through pi-ai without mutating workflow state.
   */
  async text(request: LlmTextRequest): Promise<string> {
    validateTextRequest(request, "LLM text request");
    const model = this.model(request.model);
    const startedAt = logStart(this.logger, "text", {
      name: request.name ?? "unnamed",
      model: model.id,
      inputChars: requestInputChars(request),
    });

    try {
      const message = await complete(model, {
        systemPrompt: request.instruction,
        messages: request.messages,
      }, this.options());
      assertAssistantSucceeded(message);
      const text = textFromAssistant(message).trim();
      logDone(this.logger, "text", startedAt, { outputChars: text.length, usage: usageForLog(message.usage) });
      return text;
    } catch (error) {
      logDone(this.logger, "text", startedAt, { error: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Streams render text deltas while preserving the final assistant text for session history.
   */
  async *streamText(request: LlmTextRequest): AsyncIterable<LlmTextStreamEvent> {
    validateTextRequest(request, "LLM streamText request");
    const model = this.model(request.model);
    const startedAt = logStart(this.logger, "text.stream", {
      name: request.name ?? "unnamed",
      model: model.id,
      inputChars: requestInputChars(request),
    });
    let finalText = "";

    try {
      for await (const event of stream(model, {
        systemPrompt: request.instruction,
        messages: request.messages,
      }, this.options())) {
        if (event.type === "text_delta") {
          finalText += event.delta;
          yield { type: "text_delta", delta: event.delta };
          continue;
        }

        if (event.type === "done") {
          const text = textFromAssistant(event.message).trim();
          finalText = text.length > 0 ? text : finalText.trim();
          logDone(this.logger, "text.stream", startedAt, {
            outputChars: finalText.length,
            usage: usageForLog(event.message.usage),
          });
          const usage = usageFromPi(event.message.usage);
          yield usage ? { type: "done", text: finalText, usage } : { type: "done", text: finalText };
          return;
        }

        if (event.type === "error") {
          throw new Error(event.error.errorMessage ?? "pi-ai stream failed");
        }
      }

      const text = finalText.trim();
      logDone(this.logger, "text.stream", startedAt, { outputChars: text.length });
      yield { type: "done", text };
    } catch (error) {
      logDone(this.logger, "text.stream", startedAt, { error: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Extracts structured data via a pi-ai tool call, then validates with the workflow Zod schema.
   */
  async structured<TSchema extends z.ZodType>(
    request: LlmStructuredRequest<TSchema>,
  ): Promise<z.infer<TSchema>> {
    validateStructuredRequest(request);
    const model = this.model(request.model);
    const toolName = "emit_structured_result";
    const tool = structuredTool(toolName, request.name, request.schema);
    const startedAt = logStart(this.logger, "structured.tool", {
      name: request.name,
      model: model.id,
    });

    try {
      const message = await complete(
        model,
        {
          systemPrompt: structuredSystemPrompt(request.instruction, toolName, request.name),
          messages: request.messages,
          tools: [tool],
        },
        {
          ...this.options(),
          toolChoice: { type: "function", function: { name: toolName } },
        },
      );
      assertAssistantSucceeded(message);

      const toolCall = message.content.find(
        (block): block is ToolCall => block.type === "toolCall" && block.name === toolName,
      );
      if (!toolCall) throw new Error(`pi-ai did not return ${toolName} for ${request.name}`);

      const parsed = request.schema.parse(toolCall.arguments);
      logDone(this.logger, "structured.tool", startedAt, {
        argumentChars: safeJsonStringify(toolCall.arguments).length,
        usage: usageForLog(message.usage),
      });
      return parsed;
    } catch (error) {
      logDone(this.logger, "structured.tool", startedAt, { error: errorMessage(error) });
      throw error;
    }
  }

  private model(requestModel: string | undefined): PiAiOpenAiModel {
    validateOptionalNonEmptyString(requestModel, "LLM request.model");
    if (!requestModel || requestModel === this.baseModel.id) return this.baseModel;
    return { ...this.baseModel, id: requestModel, name: requestModel };
  }

  private options(): { apiKey?: string } {
    return this.apiKey ? { apiKey: this.apiKey } : {};
  }

}

/**
 * Validates public LLM client construction options before pi-ai model wiring.
 * Input: caller supplied options.
 * Output: narrows options to `LlmClientOptions` or throws a stable configuration error.
 * Boundary: this does not validate provider credentials against the network.
 */
function validateLlmClientOptions(options: unknown): asserts options is LlmClientOptions {
  if (!isPlainRecord(options)) {
    throw new Error("LLM client options must be an object");
  }

  validateOptionalNonEmptyString(options.apiKey, "LLM client options.apiKey");
  validateOptionalNonEmptyString(options.baseURL, "LLM client options.baseURL");
  validateOptionalNonEmptyString(options.defaultModel, "LLM client options.defaultModel");
  if (options.baseURL !== undefined) validateUrl(options.baseURL, "LLM client options.baseURL");
  if (options.logger !== undefined && typeof options.logger !== "function") {
    throw new Error("LLM client options.logger must be a function");
  }
  if (options.model !== undefined) validateOpenAiModel(options.model, "LLM client options.model");
}

/**
 * Validates text generation requests before a provider call can be attempted.
 * Input: user or engine supplied text request.
 * Output: narrows to `LlmTextRequest`.
 * Boundary: message content is validated only to the pi-ai structural contract, not to provider policy.
 */
function validateTextRequest(value: unknown, label: string): asserts value is LlmTextRequest {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  validateOptionalNonEmptyString(value.name, `${label}.name`);
  validateOptionalNonEmptyString(value.model, `${label}.model`);
  validateRequiredNonEmptyString(value.instruction, `${label}.instruction`);
  validateMessages(value.messages, `${label}.messages`);
}

/**
 * Validates structured extraction requests before converting Zod schemas into tool parameters.
 * Input: user or engine supplied structured request.
 * Output: narrows to `LlmStructuredRequest`.
 * Boundary: schema validation proves local parse and JSON-schema conversion only.
 */
function validateStructuredRequest(value: unknown): asserts value is LlmStructuredRequest<z.ZodType> {
  validateTextRequest(value, "LLM structured request");
  const request = value as Record<string, unknown>;
  validateRequiredNonEmptyString(request.name, "LLM structured request.name");
  validateJsonSchemaCompatibleZodSchema(request.schema, "LLM structured request.schema");
}

function validateMessages(value: unknown, label: string): asserts value is Message[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  value.forEach((message, index) => validateMessage(message, `${label}[${index}]`));
}

function validateMessage(value: unknown, label: string): asserts value is Message {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  switch (value.role) {
    case "user":
      validateUserMessage(value, label);
      return;
    case "assistant":
      validateAssistantMessage(value, label);
      return;
    case "toolResult":
      validateToolResultMessage(value, label);
      return;
    default:
      throw new Error(`${label}.role must be user, assistant, or toolResult`);
  }
}

function validateUserMessage(message: Record<string, unknown>, label: string): void {
  if (typeof message.content === "string") return;
  validateContentBlocks(message.content, `${label}.content`);
}

function validateAssistantMessage(message: Record<string, unknown>, label: string): void {
  validateContentBlocks(message.content, `${label}.content`);
}

function validateToolResultMessage(message: Record<string, unknown>, label: string): void {
  validateRequiredNonEmptyString(message.toolCallId, `${label}.toolCallId`);
  validateRequiredNonEmptyString(message.toolName, `${label}.toolName`);
  validateContentBlocks(message.content, `${label}.content`);
  if (typeof message.isError !== "boolean") {
    throw new Error(`${label}.isError must be a boolean`);
  }
}

function validateContentBlocks(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a string or content block array`);
  }

  value.forEach((block, index) => validateContentBlock(block, `${label}[${index}]`));
}

function validateContentBlock(value: unknown, label: string): void {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  switch (value.type) {
    case "text":
      if (typeof value.text !== "string") throw new Error(`${label}.text must be a string`);
      return;
    case "thinking":
      if (typeof value.thinking !== "string") throw new Error(`${label}.thinking must be a string`);
      return;
    case "image":
      validateRequiredNonEmptyString(value.data, `${label}.data`);
      validateRequiredNonEmptyString(value.mimeType, `${label}.mimeType`);
      return;
    case "toolCall":
      validateRequiredNonEmptyString(value.id, `${label}.id`);
      validateRequiredNonEmptyString(value.name, `${label}.name`);
      if (!isPlainRecord(value.arguments)) throw new Error(`${label}.arguments must be an object`);
      return;
    default:
      throw new Error(`${label}.type must be text, thinking, image, or toolCall`);
  }
}

function validateOpenAiModel(value: unknown, label: string): asserts value is PiAiOpenAiModel {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  validateRequiredNonEmptyString(value.id, `${label}.id`);
  validateRequiredNonEmptyString(value.name, `${label}.name`);
  if (value.api !== "openai-completions") {
    throw new Error(`${label}.api must be openai-completions`);
  }
  validateRequiredNonEmptyString(value.provider, `${label}.provider`);
  validateRequiredNonEmptyString(value.baseUrl, `${label}.baseUrl`);
  validateUrl(value.baseUrl, `${label}.baseUrl`);
  if (typeof value.reasoning !== "boolean") {
    throw new Error(`${label}.reasoning must be a boolean`);
  }
  validateModelInput(value.input, `${label}.input`);
  validateModelCost(value.cost, `${label}.cost`);
  validatePositiveFiniteNumber(value.contextWindow, `${label}.contextWindow`);
  validatePositiveFiniteNumber(value.maxTokens, `${label}.maxTokens`);
}

function validateModelInput(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const item of value) {
    if (item !== "text" && item !== "image") {
      throw new Error(`${label} entries must be text or image`);
    }
  }
}

function validateModelCost(value: unknown, label: string): void {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    validateNonNegativeFiniteNumber(value[key], `${label}.${key}`);
  }
}

function validateJsonSchemaCompatibleZodSchema(value: unknown, label: string): asserts value is z.ZodType {
  if (!hasParser(value)) {
    throw new Error(`${label} must be a Zod schema`);
  }

  try {
    z.toJSONSchema(value as z.ZodType);
  } catch (error) {
    throw new Error(`${label} must be convertible to JSON Schema: ${errorMessage(error)}`);
  }
}

function validateRequiredNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateOptionalNonEmptyString(value: unknown, label: string): asserts value is string | undefined {
  if (value === undefined) return;
  validateRequiredNonEmptyString(value, label);
}

function validateUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
}

function validateNonNegativeFiniteNumber(value: unknown, label: string): asserts value is number {
  if (!Number.isFinite(value) || typeof value !== "number" || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}

function validatePositiveFiniteNumber(value: unknown, label: string): asserts value is number {
  if (!Number.isFinite(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function hasParser(value: unknown): value is { parse: (input: unknown) => unknown } {
  return Boolean(value) && typeof value === "object" && typeof (value as { parse?: unknown }).parse === "function";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createBaseModel(options: LlmClientOptions): PiAiOpenAiModel {
  if (shouldUseOpenAiCompatibleModel(options)) {
    return createOpenAiCompatibleModel(options.defaultModel ?? DEFAULT_MODEL, options.baseURL);
  }

  return getModel("deepseek", DEFAULT_MODEL);
}

function shouldUseOpenAiCompatibleModel(options: LlmClientOptions): boolean {
  // Preserve the historical local default unless the caller explicitly opts into OpenAI-compatible wiring.
  return Boolean(options.apiKey || options.baseURL || options.defaultModel);
}

function createOpenAiCompatibleModel(model: string, baseURL: string | undefined): PiAiOpenAiModel {
  return {
    id: model,
    name: model,
    api: "openai-completions",
    provider: baseURL ? "openai-compatible" : "openai",
    baseUrl: baseURL ?? "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function structuredTool<TSchema extends z.ZodType>(toolName: string, name: string, schema: TSchema): Tool {
  return {
    name: toolName,
    description: [
      `Emit the final structured result for ${name}.`,
      "This tool is mandatory for the response and must be called exactly once.",
      "Populate arguments with only schema-valid data grounded in the provided messages and instruction.",
      "Do not place narrative text, markdown, or JSON outside the tool call.",
    ].join(" "),
    parameters: stripJsonSchemaMetadata(z.toJSONSchema(schema)) as Tool["parameters"],
  };
}

function structuredSystemPrompt(instruction: string, toolName: string, name: string): string {
  return [
    instruction.trim(),
    "",
    "Structured output contract:",
    `- You must call exactly one tool: ${toolName}.`,
    "- The tool call is the final answer; do not write plain text, markdown, or JSON outside the tool call.",
    "- Put the complete structured result in the tool arguments and make every value conform to the JSON schema.",
    "- If information is absent, use schema-appropriate empty/default values or omit optional fields; never invent unsupported facts.",
    `- This contract applies to ${name}.`,
  ].join("\n");
}

function stripJsonSchemaMetadata(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripJsonSchemaMetadata);
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "$schema")
      .map(([key, value]) => [key, stripJsonSchemaMetadata(value)]),
  );
}

function assertAssistantSucceeded(message: AssistantMessage): void {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `pi-ai stopped with ${message.stopReason}`);
  }
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function requestInputChars(request: LlmTextRequest | LlmStructuredRequest<z.ZodType>): number {
  return request.messages.map(messageTextForLog).join("\n").length;
}

function messageTextForLog(message: Message): string {
  if (message.role === "user") {
    return typeof message.content === "string" ? message.content : safeJsonStringify(message.content);
  }
  if (message.role === "toolResult") return safeJsonStringify(message.content);
  return safeJsonStringify(message.content);
}

function usageFromPi(usage: Usage | undefined): LlmUsage | undefined {
  if (!usage) return undefined;
  return { inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.totalTokens };
}

function usageForLog(usage: Usage | undefined): unknown {
  return usageFromPi(usage);
}

function logStart(logger: ((line: string) => void) | undefined, phase: string, detail?: unknown): number {
  logger?.(formatLogLine(phase, "start", undefined, detail));
  return Date.now();
}

function logDone(
  logger: ((line: string) => void) | undefined,
  phase: string,
  startedAt: number,
  detail?: unknown,
): void {
  logger?.(formatLogLine(phase, "done", Date.now() - startedAt, detail));
}

function formatLogLine(phase: string, status: "start" | "done", durationMs?: number, detail?: unknown): string {
  const duration = durationMs === undefined ? "" : ` ${durationMs}ms`;
  const suffix = detail === undefined ? "" : ` ${safeJsonStringify(detail)}`;
  return `[llm] ${phase} ${status}${duration}${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
