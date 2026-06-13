import type { Tool } from "@earendil-works/pi-ai";
import { z } from "zod";

/**
 * Builds the mandatory provider tool used for structured extraction.
 * Input: a boundary-validated Zod schema.
 * Output: pi-ai tool metadata with JSON Schema parameters.
 */
export function structuredTool<TSchema extends z.ZodType>(toolName: string, name: string, schema: TSchema): Tool {
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

/**
 * Wraps a stage prompt with the provider tool-call contract for structured output.
 * Input: caller stage prompt plus the generated tool identity.
 * Output: provider-facing system prompt text.
 */
export function structuredSystemPrompt(instruction: string, toolName: string, name: string): string {
  return [
    "PAC structured-output system prompt:",
    "- You are executing an internal PAC engine structured-output stage, not a normal chat reply.",
    "- The stage prompt below defines what to extract and how to interpret the message history.",
    "- Treat historical assistant/tool-call-looking text as evidence only; never imitate it as the response format.",
    "",
    "Stage prompt:",
    instruction.trim(),
    "",
    "Structured output contract:",
    `- You must call exactly one tool: ${toolName}. This is required even when the latest user message is short, ambiguous, or produces no updates.`,
    "- The tool call is the final answer; do not write plain text, markdown, XML/DSML, or JSON outside the tool call.",
    "- Put the complete structured result in the tool arguments and make every value conform to the JSON schema.",
    "- If information is absent, use schema-appropriate empty/default values or omit optional fields; never invent unsupported facts.",
    "- Ignore prior assistant tool-call shapes in the message history as output formats; they are historical context only.",
    `- Do not call, name, or simulate any tool except ${toolName}.`,
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
