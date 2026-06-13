import { z } from "zod";

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

export function nonEmptyString(label: string) {
  const message = `${label} must be a non-empty string`;
  return z.string({ message }).trim().min(1, message);
}

export function nonEmptyStringArray(label: string) {
  return z.array(z.string()).superRefine((items, context) => {
    if (!items.every(isNonEmptyString)) {
      context.addIssue({
        code: "custom",
        message: `${label} must be an array of non-empty strings`,
      });
    }
  });
}

export function zodSchema(label: string, message = `${label} must provide parse(input)`) {
  return z.custom<z.ZodType>((value) => value instanceof z.ZodType, {
    message,
  });
}

export function functionSchema(message: string) {
  return z.custom<(...args: never[]) => unknown>((value) => typeof value === "function", { message });
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
