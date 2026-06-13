import { z } from "zod";
import { errorMessage } from "../utils/errors.js";
import {
  absoluteUrl,
  addBoundaryIssue as addIssue,
  addSchemaIssue,
  functionSchema,
  nonEmptyString,
  nonNegativeFiniteNumber,
  parseBoundary,
  parserSchema,
  positiveFiniteNumber,
  recordSchema,
  type BoundaryIssueContext,
  type BoundaryIssuePath,
} from "../utils/schema-boundary.js";
import type { LlmClientOptions, LlmStructuredRequest, LlmTextRequest } from "./client.js";

/**
 * Checks public LLM client construction options before pi-ai model wiring.
 * Input: caller supplied options.
 * Output: narrows options to `LlmClientOptions` or throws a stable configuration error.
 * Boundary: this does not validate provider credentials against the network.
 */
export function validateLlmClientOptions(options: unknown): asserts options is LlmClientOptions {
  parseBoundary(llmClientOptionsSchema(), options);
}

/**
 * Checks text generation requests before a provider call can be attempted.
 * Input: user or engine supplied text request.
 * Output: narrows to `LlmTextRequest`.
 * Boundary: message content is validated only to the pi-ai structural contract, not to provider policy.
 */
export function validateTextRequest(value: unknown, label: string): asserts value is LlmTextRequest {
  parseBoundary(textRequestSchema(label), value);
}

/**
 * Checks structured extraction requests before converting Zod schemas into tool parameters.
 * Input: user or engine supplied structured request.
 * Output: narrows to `LlmStructuredRequest`.
 * Boundary: schema validation proves local parse and JSON-schema conversion only.
 */
export function validateStructuredRequest(value: unknown): asserts value is LlmStructuredRequest<z.ZodType> {
  validateTextRequest(value, "LLM structured request");
  parseBoundary(
    z.object(
      {
        name: nonEmptyString("LLM structured request.name"),
        schema: jsonSchemaCompatibleZodSchema("LLM structured request.schema"),
      },
      { message: "LLM structured request must be an object" },
    ),
    value,
  );
}

function llmClientOptionsSchema() {
  return z.object(
    {
      apiKey: nonEmptyString("LLM client options.apiKey").optional(),
      baseURL: absoluteUrl("LLM client options.baseURL").optional(),
      defaultModel: nonEmptyString("LLM client options.defaultModel").optional(),
      logger: functionSchema("LLM client options.logger must be a function").optional(),
      model: openAiModelSchema("LLM client options.model").optional(),
    },
    { message: "LLM client options must be an object" },
  );
}

function textRequestSchema(label: string) {
  return z.object(
    {
      name: nonEmptyString(`${label}.name`).optional(),
      model: nonEmptyString(`${label}.model`).optional(),
      instruction: nonEmptyString(`${label}.instruction`),
      messages: messagesSchema(`${label}.messages`),
    },
    { message: `${label} must be an object` },
  );
}

function messagesSchema(label: string) {
  return z.array(z.unknown(), { message: `${label} must be an array` }).superRefine((messages, context) => {
    messages.forEach((message, index) => {
      addMessageIssues(message, `${label}[${index}]`, context, [index]);
    });
  });
}

function addMessageIssues(value: unknown, label: string, context: BoundaryIssueContext, path: BoundaryIssuePath): void {
  const message = readRecord(value, label, context, path);
  if (!message) return;

  switch (message.role) {
    case "user":
      if (typeof message.content === "string") return;
      addContentBlocksIssues(message.content, `${label}.content`, context, [...path, "content"]);
      return;
    case "assistant":
      addContentBlocksIssues(message.content, `${label}.content`, context, [...path, "content"]);
      return;
    case "toolResult":
      addSchemaIssue(nonEmptyString(`${label}.toolCallId`), message.toolCallId, context, [...path, "toolCallId"]);
      addSchemaIssue(nonEmptyString(`${label}.toolName`), message.toolName, context, [...path, "toolName"]);
      addContentBlocksIssues(message.content, `${label}.content`, context, [...path, "content"]);
      addSchemaIssue(z.boolean({ message: `${label}.isError must be a boolean` }), message.isError, context, [
        ...path,
        "isError",
      ]);
      return;
    default:
      addIssue(context, `${label}.role must be user, assistant, or toolResult`, [...path, "role"]);
  }
}

function addContentBlocksIssues(
  value: unknown,
  label: string,
  context: BoundaryIssueContext,
  path: BoundaryIssuePath,
): void {
  if (!Array.isArray(value)) {
    addIssue(context, `${label} must be a string or content block array`, path);
    return;
  }

  value.forEach((block, index) => {
    addContentBlockIssues(block, `${label}[${index}]`, context, [...path, index]);
  });
}

function addContentBlockIssues(
  value: unknown,
  label: string,
  context: BoundaryIssueContext,
  path: BoundaryIssuePath,
): void {
  const block = readRecord(value, label, context, path);
  if (!block) return;

  switch (block.type) {
    case "text":
      addSchemaIssue(z.string({ message: `${label}.text must be a string` }), block.text, context, [...path, "text"]);
      return;
    case "thinking":
      addSchemaIssue(z.string({ message: `${label}.thinking must be a string` }), block.thinking, context, [
        ...path,
        "thinking",
      ]);
      return;
    case "image":
      addSchemaIssue(nonEmptyString(`${label}.data`), block.data, context, [...path, "data"]);
      addSchemaIssue(nonEmptyString(`${label}.mimeType`), block.mimeType, context, [...path, "mimeType"]);
      return;
    case "toolCall":
      addSchemaIssue(nonEmptyString(`${label}.id`), block.id, context, [...path, "id"]);
      addSchemaIssue(nonEmptyString(`${label}.name`), block.name, context, [...path, "name"]);
      addSchemaIssue(recordSchema(`${label}.arguments must be an object`), block.arguments, context, [
        ...path,
        "arguments",
      ]);
      return;
    default:
      addIssue(context, `${label}.type must be text, thinking, image, or toolCall`, [...path, "type"]);
  }
}

function openAiModelSchema(label: string) {
  return z.object(
    {
      id: nonEmptyString(`${label}.id`),
      name: nonEmptyString(`${label}.name`),
      api: z.custom<"openai-completions">((value) => value === "openai-completions", {
        message: `${label}.api must be openai-completions`,
      }),
      provider: nonEmptyString(`${label}.provider`),
      baseUrl: absoluteUrl(`${label}.baseUrl`),
      reasoning: z.boolean({ message: `${label}.reasoning must be a boolean` }),
      input: modelInputSchema(`${label}.input`),
      cost: modelCostSchema(`${label}.cost`),
      contextWindow: positiveFiniteNumber(`${label}.contextWindow`),
      maxTokens: positiveFiniteNumber(`${label}.maxTokens`),
    },
    { message: `${label} must be an object` },
  );
}

function modelInputSchema(label: string) {
  return z.array(z.unknown(), { message: `${label} must be a non-empty array` }).superRefine((input, context) => {
    if (input.length === 0) {
      addIssue(context, `${label} must be a non-empty array`);
      return;
    }
    for (const item of input) {
      if (item !== "text" && item !== "image") {
        addIssue(context, `${label} entries must be text or image`);
      }
    }
  });
}

function modelCostSchema(label: string) {
  return z.object(
    {
      input: nonNegativeFiniteNumber(`${label}.input`),
      output: nonNegativeFiniteNumber(`${label}.output`),
      cacheRead: nonNegativeFiniteNumber(`${label}.cacheRead`),
      cacheWrite: nonNegativeFiniteNumber(`${label}.cacheWrite`),
    },
    { message: `${label} must be an object` },
  );
}

function jsonSchemaCompatibleZodSchema(label: string) {
  return parserSchema(`${label} must be a Zod schema`)
    .superRefine((schema, context) => {
      try {
        z.toJSONSchema(schema as z.ZodType);
      } catch (error) {
        addIssue(context, `${label} must be convertible to JSON Schema: ${errorMessage(error)}`);
      }
    });
}

function readRecord(
  value: unknown,
  label: string,
  context: BoundaryIssueContext,
  path: BoundaryIssuePath,
): Record<string, unknown> | undefined {
  const parsed = recordSchema(`${label} must be an object`).safeParse(value);
  if (!parsed.success) {
    addIssue(context, `${label} must be an object`, path);
    return undefined;
  }

  return parsed.data;
}
