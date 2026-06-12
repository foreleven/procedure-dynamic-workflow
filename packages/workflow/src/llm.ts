import { z } from "zod";
import type { MaybePromise } from "./common.js";

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface LlmTextRequest<TInput = unknown> {
  name?: string;
  model?: string;
  instruction: string;
  input?: TInput;
  messages?: LlmMessage[];
}

export interface LlmStructuredRequest<TSchema extends z.ZodType, TInput = unknown> {
  name: string;
  model?: string;
  instruction: string;
  schema: TSchema;
  input: TInput;
}

export interface LlmClient {
  text<TInput = unknown>(request: LlmTextRequest<TInput>): MaybePromise<string>;

  structured<TSchema extends z.ZodType, TInput = unknown>(
    request: LlmStructuredRequest<TSchema, TInput>,
  ): MaybePromise<z.infer<TSchema>>;
}
