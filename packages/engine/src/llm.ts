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

type LlmTextRequest = {
  name?: string;
  model?: string;
  instruction: string;
  messages: Message[];
};

type LlmStructuredRequest<TSchema extends z.ZodType> = {
  name: string;
  model?: string;
  instruction: string;
  schema: TSchema;
  messages: Message[];
};

type LlmUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

type LlmTextStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; text: string; usage?: LlmUsage };

export interface LlmClient {
  text(request: LlmTextRequest): Promise<string>;
  streamText?(request: LlmTextRequest): AsyncIterable<LlmTextStreamEvent>;
  structured<TSchema extends z.ZodType>(
    request: LlmStructuredRequest<TSchema>,
  ): Promise<z.infer<TSchema>>;
}

type PiAiOpenAiModel = Model<"openai-completions">;

interface LlmClientOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel: string;
  model?: PiAiOpenAiModel;
  logger?: (line: string) => void;
}

export function createLlmClient(options: LlmClientOptions = { defaultModel: "deepseek-v4-flash" }): LlmClient {
  return new PiAiLlmClient(options);
}

class PiAiLlmClient implements LlmClient {
  private readonly apiKey?: string;
  private readonly baseModel: PiAiOpenAiModel;
  private readonly logger?: (line: string) => void;

  constructor(options: LlmClientOptions) {
    this.apiKey = options.apiKey;
    const model = getModel("deepseek", "deepseek-v4-flash");
    this.baseModel = options.model ?? model;
    this.logger = options.logger;
  }

  /**
   * Runs plain assistant text generation through pi-ai without mutating workflow state.
   */
  async text(request: LlmTextRequest): Promise<string> {
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
          yield { type: "done", text: finalText, usage: usageFromPi(event.message.usage) };
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
        argumentChars: JSON.stringify(toolCall.arguments).length,
        usage: usageForLog(message.usage),
      });
      return parsed;
    } catch (error) {
      logDone(this.logger, "structured.tool", startedAt, { error: errorMessage(error) });
      throw error;
    }
  }

  private model(requestModel: string | undefined): PiAiOpenAiModel {
    if (!requestModel || requestModel === this.baseModel.id) return this.baseModel;
    return { ...this.baseModel, id: requestModel, name: requestModel };
  }

  private options(): { apiKey?: string } {
    return this.apiKey ? { apiKey: this.apiKey } : {};
  }

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
  if (message.role === "user") return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  if (message.role === "toolResult") return JSON.stringify(message.content);
  return JSON.stringify(message.content);
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
  const suffix = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  return `[llm] ${phase} ${status}${duration}${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
