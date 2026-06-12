import "dotenv/config";
import { createOpenAiLlmClient, type LlmClient } from "@pac/workflow";

export interface OpenAiEnvOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  logger?: (line: string) => void;
}

export function createOpenAiLlmFromEnv(options: OpenAiEnvOptions = {}): LlmClient {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const defaultModel = options.model ?? process.env.OPENAI_MODEL;
  const baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY in environment or .env");
  }

  if (!defaultModel) {
    throw new Error("Missing OPENAI_MODEL in environment or .env");
  }

  return createOpenAiLlmClient({
    apiKey,
    defaultModel,
    baseURL: blankToUndefined(baseURL),
    logger: options.logger,
  });
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
