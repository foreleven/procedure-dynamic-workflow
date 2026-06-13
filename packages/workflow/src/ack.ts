import { z } from "zod";

export const AckOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  value: z.unknown().optional(),
});

export const AckRequestSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  options: z.array(AckOptionSchema).min(1),
});

export type AckOption = z.infer<typeof AckOptionSchema>;
export type AckRequest = z.infer<typeof AckRequestSchema>;

export interface AckSelection {
  request: AckRequest;
  option: AckOption;
  index: number;
}

/**
 * Resolves a user's short confirmation reply against the active ack options.
 * Input: a persisted AckRequest and the latest user message.
 * Output: the matched option with its zero-based index, or undefined when the message is ambiguous.
 * Boundary: this helper never mutates workflow state; workflows must decide how an option maps to business state.
 */
export function resolveAckSelection(request: AckRequest, message: string): AckSelection | undefined {
  const normalizedMessage = normalizeAckText(message);
  if (!normalizedMessage) return undefined;

  const indexedOption = optionByOrdinal(request, normalizedMessage) ?? optionByLabel(request, normalizedMessage);
  if (indexedOption) return indexedOption;

  if (request.options.length === 1 && isPositiveConfirmation(normalizedMessage)) {
    return {
      request,
      option: request.options[0]!,
      index: 0,
    };
  }

  return undefined;
}

function optionByOrdinal(request: AckRequest, normalizedMessage: string): AckSelection | undefined {
  const ordinal = parseOrdinal(normalizedMessage);
  if (ordinal === undefined) return undefined;

  const index = ordinal - 1;
  const option = request.options[index];
  return option ? { request, option, index } : undefined;
}

function optionByLabel(request: AckRequest, normalizedMessage: string): AckSelection | undefined {
  for (const [index, option] of request.options.entries()) {
    const normalizedId = normalizeAckText(option.id);
    const normalizedLabel = normalizeAckText(option.label);
    if (
      normalizedMessage === normalizedId ||
      normalizedMessage === normalizedLabel ||
      normalizedMessage.includes(normalizedLabel) ||
      normalizedLabel.includes(normalizedMessage)
    ) {
      return { request, option, index };
    }
  }

  return undefined;
}

function parseOrdinal(value: string): number | undefined {
  const numericMatch = value.match(/(?:第)?([1-9]\d*)(?:个|项|家|辆|号)?/);
  if (numericMatch?.[1]) return Number(numericMatch[1]);

  // Users often attach a classifier to Chinese ordinals, for example "第二个" or "第三辆".
  const valueWithoutClassifier = value.replace(/(?:个|项|家|辆|号)$/, "");
  const chineseOrdinals: Record<string, number> = {
    一: 1,
    第一: 1,
    一个: 1,
    二: 2,
    第二: 2,
    两: 2,
    三: 3,
    第三: 3,
    四: 4,
    第四: 4,
    五: 5,
    第五: 5,
  };

  return chineseOrdinals[valueWithoutClassifier] ?? chineseOrdinals[value];
}

function isPositiveConfirmation(value: string): boolean {
  return /^(确认|可以|对|是|好的|好|ok|yes|y)$/.test(value);
}

function normalizeAckText(value: string): string {
  return value.toLowerCase().replace(/[\s,，。.!！?？、：:;；"'“”‘’（）()]+/g, " ").trim();
}
