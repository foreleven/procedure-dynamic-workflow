import { z } from "zod";
import { errorMessage } from "./errors.js";

export type BoundaryIssueContext = z.RefinementCtx;
export type BoundaryIssuePath = Array<string | number>;

export function parseBoundary(schema: z.ZodType, value: unknown): void {
  try {
    schema.parse(value);
  } catch (error) {
    throw new Error(errorMessage(error));
  }
}

export function nonEmptyString(label: string) {
  const message = `${label} must be a non-empty string`;
  return z.string({ message }).trim().min(1, message);
}

export function absoluteUrl(label: string) {
  return nonEmptyString(label).refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: `${label} must be a valid absolute URL` },
  );
}

export function functionSchema<TFunction extends (...args: never[]) => unknown = (...args: never[]) => unknown>(
  message?: string,
) {
  return z.custom<TFunction>((value) => typeof value === "function", message ? { message } : undefined);
}

export function recordSchema(message: string) {
  return z.record(z.string(), z.unknown(), { message });
}

export function parserSchema<TParser extends { parse: (input: unknown) => unknown } = { parse: (input: unknown) => unknown }>(
  message?: string,
) {
  return z.custom<TParser>((value) => hasParser(value), message ? { message } : undefined);
}

export function zodTypeSchema() {
  return z.custom<z.ZodType>((value) => value instanceof z.ZodType);
}

export function nonNegativeFiniteNumber(label: string) {
  const message = `${label} must be a non-negative finite number`;
  return z.number({ message }).finite(message).min(0, message);
}

export function positiveFiniteNumber(label: string) {
  const message = `${label} must be a positive finite number`;
  return z.number({ message }).finite(message).positive(message);
}

export function addBoundaryIssue(
  context: BoundaryIssueContext,
  message: string,
  path: BoundaryIssuePath = [],
): void {
  context.addIssue({
    code: "custom",
    message,
    path,
  });
}

export function addSchemaIssue(
  schema: z.ZodType,
  value: unknown,
  context: BoundaryIssueContext,
  path: BoundaryIssuePath,
): void {
  const parsed = schema.safeParse(value);
  if (parsed.success) return;

  for (const issue of parsed.error.issues) {
    addBoundaryIssue(context, issue.message, [...path, ...pathFromIssue(issue.path)]);
  }
}

export function pathFromIssue(path: PropertyKey[]): BoundaryIssuePath {
  return path.filter((item): item is string | number => typeof item === "string" || typeof item === "number");
}

function hasParser(value: unknown): value is { parse: (input: unknown) => unknown } {
  return Boolean(value) && typeof value === "object" && typeof (value as { parse?: unknown }).parse === "function";
}
