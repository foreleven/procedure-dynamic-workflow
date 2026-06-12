import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import { z } from "zod";
import type { LlmClient, LlmMessage } from "./llm.js";

export interface OpenAiLlmClientOptions {
  apiKey?: string;
  baseURL?: string;
  defaultModel: string;
  client?: OpenAI;
  logger?: (line: string) => void;
}

export function createOpenAiLlmClient(options: OpenAiLlmClientOptions): LlmClient {
  const client =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });

  const model = (requestModel: string | undefined) => requestModel ?? options.defaultModel;
  const logger = options.logger;

  return {
    text: async (request) => {
      const modelName = model(request.model);
      const input = request.messages ? llmMessagesChars(request.messages) : llmInput(request.input ?? "");
      const startedAt = logStart(logger, "text", {
        name: request.name ?? "unnamed",
        model: modelName,
        inputChars: input.length,
      });

      try {
        const output = request.messages
          ? await chatText({
              client,
              model: modelName,
              instruction: request.instruction,
              messages: request.messages,
            })
          : await responseText({
              client,
              model: modelName,
              instruction: request.instruction,
              input,
            });

        logDone(logger, "text", startedAt, { outputChars: output.length });
        return output;
      } catch (error) {
        logDone(logger, "text", startedAt, { error: errorMessage(error) });
        throw error;
      }
    },

    structured: async (request) => {
      const modelName = model(request.model);
      return structuredViaTool({
        client,
        logger,
        model: modelName,
        name: request.name,
        instruction: request.instruction,
        schema: request.schema,
        input: llmInput(request.input),
      });
    },
  };
}

async function responseText(input: {
  client: OpenAI;
  model: string;
  instruction: string;
  input: string;
}): Promise<string> {
  const response = await input.client.responses.create({
    model: input.model,
    instructions: input.instruction,
    input: input.input,
  });

  return response.output_text;
}

async function chatText(input: {
  client: OpenAI;
  model: string;
  instruction: string;
  messages: LlmMessage[];
}): Promise<string> {
  const response = await input.client.chat.completions.create({
    model: input.model,
    messages: [
      { role: "system", content: input.instruction },
      ...input.messages.map(toChatMessage),
    ],
  });

  return response.choices[0]?.message.content?.trim() ?? "";
}

function toChatMessage(message: LlmMessage): ChatCompletionMessageParam {
  if (message.role === "assistant") {
    return { role: "assistant", content: message.content };
  }

  // Chat Completions require tool_call_id for real tool messages. Workflow tool
  // entries are an audit log, so render exposes them as named user-visible context.
  if (message.role === "tool") {
    return {
      role: "user",
      content: `Tool ${message.name ?? "tool"} result:\n${message.content}`,
    };
  }

  return { role: "user", content: message.content };
}

async function structuredViaTool<TSchema extends z.ZodType>(input: {
  client: OpenAI;
  logger?: (line: string) => void;
  model: string;
  name: string;
  instruction: string;
  schema: TSchema;
  input: string;
}): Promise<z.infer<TSchema>> {
  const toolName = "emit_structured_result";
  const tool: ChatCompletionTool = {
    type: "function",
    function: {
      name: toolName,
      description: `Return the structured result for ${input.name}.`,
      parameters: z.toJSONSchema(input.schema),
    },
  };
  const toolChoice: ChatCompletionToolChoiceOption = {
    type: "function",
    function: {
      name: toolName,
    },
  };
  const startedAt = logStart(input.logger, "structured.tool", {
    name: input.name,
    model: input.model,
    inputChars: input.input.length,
    schemaChars: JSON.stringify(tool.function.parameters).length,
  });

  try {
    const maxAttempts = 8;
    let lastMissingToolOutput = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await input.client.chat.completions.create({
      model: input.model,
        messages: [
          {
            role: "system",
            content: `${input.instruction}

You must call ${toolName} with the structured result.
Do not answer in text.
Do not emit an empty message.`,
          },
          {
            role: "user",
            content: input.input,
          },
        ],
      tools: [tool],
      tool_choice: toolChoice,
        max_tokens: 800,
    });

      const message = response.choices[0]?.message;
      const toolCall = message?.tool_calls?.find(isFunctionToolCall);
      if (!toolCall) {
        lastMissingToolOutput = summarizeChatMessage(message);
        if (attempt < maxAttempts) continue;
        throw new Error(`OpenAI returned no function call for ${input.name}: ${lastMissingToolOutput}`);
      }

      try {
        const parsed = input.schema.parse(JSON.parse(toolCall.function.arguments));
        logDone(input.logger, "structured.tool", startedAt, {
          argumentChars: toolCall.function.arguments.length,
          attempts: attempt,
        });
        return parsed;
      } catch (error) {
        lastMissingToolOutput = `invalid tool arguments: ${errorMessage(error)}; arguments=${toolCall.function.arguments}`;
        if (attempt < maxAttempts) continue;
        throw new Error(`OpenAI returned invalid function arguments for ${input.name}: ${lastMissingToolOutput}`);
      }
    }

    throw new Error(`OpenAI returned no function call for ${input.name}: ${lastMissingToolOutput}`);
  } catch (error) {
    logDone(input.logger, "structured.tool", startedAt, { error: errorMessage(error) });
    throw error;
  }
}

function llmInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, jsonForLlm, 2);
}

function llmMessagesChars(messages: LlmMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

function jsonForLlm(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (typeof value === "function") return undefined;
  return value;
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

function summarizeChatMessage(message: unknown): string {
  if (!message || typeof message !== "object") return JSON.stringify(message);
  const candidate = message as { role?: unknown; content?: unknown; tool_calls?: unknown };
  return JSON.stringify({
    role: candidate.role,
    content: candidate.content,
    tool_calls: candidate.tool_calls,
  });
}

function isFunctionToolCall(item: unknown): item is ChatCompletionMessageFunctionToolCall {
  if (!item || typeof item !== "object") return false;
  const candidate = item as { type?: unknown; function?: { name?: unknown; arguments?: unknown } };
  return (
    candidate.type === "function" &&
    typeof candidate.function?.name === "string" &&
    typeof candidate.function.arguments === "string"
  );
}
