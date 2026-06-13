import {
  getModel,
  type Model,
} from "@earendil-works/pi-ai";

export type PiAiOpenAiModel = Model<"openai-completions">;

type LlmModelOptions = {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  defaultModel?: string | undefined;
};

const DEFAULT_MODEL = "deepseek-v4-flash";

/**
 * Resolves the provider model used by the pi-ai client.
 * Input: validated client options.
 * Output: a pi-ai OpenAI-completions compatible model.
 * Boundary: credential validity is intentionally left to the provider request.
 */
export function createBaseModel(options: LlmModelOptions): PiAiOpenAiModel {
  if (shouldUseOpenAiCompatibleModel(options)) {
    return createOpenAiCompatibleModel(options.defaultModel ?? DEFAULT_MODEL, options.baseURL);
  }

  return getModel("deepseek", DEFAULT_MODEL);
}

/**
 * Applies a per-request model override without rebuilding provider defaults.
 * Input: trusted request model id from the LLM request boundary.
 * Output: the base model or a copy with the requested id/name.
 */
export function resolveRequestModel(
  baseModel: PiAiOpenAiModel,
  requestModel: string | undefined,
): PiAiOpenAiModel {
  if (!requestModel || requestModel === baseModel.id) return baseModel;
  return { ...baseModel, id: requestModel, name: requestModel };
}

function shouldUseOpenAiCompatibleModel(options: LlmModelOptions): boolean {
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
