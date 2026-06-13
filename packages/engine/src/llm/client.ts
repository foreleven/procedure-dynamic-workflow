import {
  complete,
  stream,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { errorMessage } from "../utils/errors.js";
import { safeJsonStringify } from "../utils/json.js";
import {
  validateLlmClientOptions,
  validateStructuredRequest,
  validateTextRequest,
} from "./request-boundary.js";
import { createBaseModel, resolveRequestModel, type PiAiOpenAiModel } from "./models.js";
import { structuredSystemPrompt, structuredTool } from "./structured-output.js";

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
    return resolveRequestModel(this.baseModel, requestModel);
  }

  private options(): { apiKey?: string } {
    return this.apiKey ? { apiKey: this.apiKey } : {};
  }

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
