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
 * Extends the caller instruction with the tool-call contract for structured output.
 * Input: caller instruction plus the generated tool identity.
 * Output: provider-facing system prompt text.
 */
export function structuredSystemPrompt(instruction: string, toolName: string, name: string): string {
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
