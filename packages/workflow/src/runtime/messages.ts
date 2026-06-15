import { z } from "zod";
import type { JsonRecord } from "../common.js";
import {
  nonEmptyString,
  parseSchema,
} from "../utils/schema.js";

export interface WorkflowUserMessage extends JsonRecord {
  role: "user";
  id?: string;
  content: string;
}

export interface WorkflowAssistantMessage extends JsonRecord {
  role: "assistant";
  id?: string;
  content: string;
}

export interface WorkflowToolMessage extends JsonRecord {
  role: "tool";
  id?: string;
  name: string;
  call?: unknown;
  result: unknown;
  isError?: boolean;
}

export type WorkflowMessage = WorkflowUserMessage | WorkflowAssistantMessage | WorkflowToolMessage;

export interface ToolMessageInput {
  id?: string;
  name: string;
  call?: unknown;
  result: unknown;
  isError?: boolean;
}

/**
 * Creates a workflow tool-result history entry for connector or derived data.
 * Input: a stable tool name, optional call arguments, result payload, and optional explicit id.
 * Output: a JSON-shaped `WorkflowToolMessage` that the engine appends to runtime messages.
 * Boundary: this class does not know provider-specific LLM formats; engine adapters convert it later.
 */
export class ToolMessage implements WorkflowToolMessage {
  readonly [key: string]: unknown;
  readonly role = "tool";
  readonly id?: string;
  readonly name: string;
  readonly call?: unknown;
  readonly result: unknown;
  readonly isError?: boolean;

  constructor(input: ToolMessageInput) {
    validateToolMessageInput(input);

    this.name = input.name;
    this.result = input.result;
    if (input.id !== undefined) this.id = input.id;
    if ("call" in input) this.call = input.call;
    if (input.isError !== undefined) this.isError = input.isError;
  }

  /**
   * Returns the plain runtime message shape for persistence and structured cloning.
   * Input: this tool message instance.
   * Output: a JSON-shaped workflow tool message with only explicitly supplied optional fields.
   * Boundary: values are not deep-cloned; the runtime owns cloning at state/session boundaries.
   */
  toJSON(): WorkflowToolMessage {
    const message: WorkflowToolMessage = {
      role: "tool",
      name: this.name,
      result: this.result,
    };

    if (this.id !== undefined) message.id = this.id;
    if (Object.hasOwn(this, "call")) message.call = this.call;
    if (this.isError !== undefined) message.isError = this.isError;

    return message;
  }
}

/**
 * Guards tool-message construction input before it is stored in runtime history.
 * Input: caller supplied ToolMessage payload.
 * Output: narrows to ToolMessageInput or throws a stable validation error.
 * Boundary: result and call payloads are intentionally opaque workflow-owned values.
 */
function validateToolMessageInput(value: unknown): asserts value is ToolMessageInput {
  parseSchema(toolMessageInputSchema(), value);
}

function toolMessageInputSchema() {
  return z
    .object(
      {
        id: nonEmptyString("ToolMessage id").optional(),
        name: nonEmptyString("ToolMessage name"),
        call: z.unknown().optional(),
        result: z.unknown().optional(),
        isError: z.boolean({ message: "ToolMessage isError must be a boolean" }).optional(),
      },
      { message: "ToolMessage input must be an object" },
    )
    .superRefine((input, context) => {
      if (!Object.hasOwn(input, "result")) {
        context.addIssue({
          code: "custom",
          message: "ToolMessage result is required",
          path: ["result"],
        });
      }
    });
}
