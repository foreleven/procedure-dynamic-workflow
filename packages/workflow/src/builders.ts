import { z } from "zod";
import {
  JsonRecordSchema,
  type RoutingProfile,
  type RoutingThresholds,
} from "./common.js";

const RESERVED_STATE_FIELDS = new Set(["messages"]);

export const DEFAULT_ROUTING_THRESHOLDS: RoutingThresholds = {
  localAccept: 0.78,
  localUncertain: 0.55,
  globalAccept: 0.75,
};

export function defineRouting(
  routing: Omit<RoutingProfile, "thresholds"> & {
    thresholds?: Partial<RoutingThresholds>;
  },
): RoutingProfile {
  validateRoutingConfig(routing);
  validateRoutingTerms(routing.examples, "routing.examples");
  validateRoutingTerms(routing.entities, "routing.entities");
  validateRoutingTerms(routing.neighbors, "routing.neighbors");
  validateRoutingThresholdOverrides(routing.thresholds);

  const thresholds = {
    ...DEFAULT_ROUTING_THRESHOLDS,
    ...routing.thresholds,
  };
  validateRoutingThresholds(thresholds);

  return {
    examples: routing.examples,
    entities: routing.entities,
    neighbors: routing.neighbors,
    thresholds,
  };
}

const DEFAULT_PATCH_INSTRUCTION = `
Extract only structured updates.
Do not reason step by step.
Do not generate final response.
`;

export interface PatchPolicy<TPatch = unknown> {
  model?: string | undefined;
  progress?: string | undefined;
  schema: z.ZodType<TPatch>;
  instruction: string;
}

function patchSchema<TStatePatchShape extends z.ZodRawShape>(statePatchShape: TStatePatchShape) {
  const statePatchShapeForLlm = optionalNullableShape(statePatchShape);

  return z.object({
    sessionPatch: z
      .object({
        facts: JsonRecordSchema.nullable().optional(),
        preferences: JsonRecordSchema.nullable().optional(),
        goals: z.array(z.string()).nullable().optional(),
        constraints: z.array(z.string()).nullable().optional(),
      })
      .optional()
      .nullable(),
    statePatch: z.object(statePatchShapeForLlm).optional().nullable(),
  });
}

type PatchOutput<TStatePatchShape extends z.ZodRawShape> = z.infer<
  ReturnType<typeof patchSchema<TStatePatchShape>>
>;

export function definePatch<TStatePatchShape extends z.ZodRawShape>(
  config: {
    state: TStatePatchShape;
    model?: string | undefined;
    progress?: string | undefined;
    instruction?: string | undefined;
  },
): PatchPolicy<PatchOutput<TStatePatchShape>> {
  validatePatchConfig(config);
  const policy: PatchPolicy<PatchOutput<TStatePatchShape>> = {
    schema: patchSchema(config.state),
    instruction: config.instruction ?? DEFAULT_PATCH_INSTRUCTION,
  };

  if (config.model !== undefined) policy.model = config.model;
  if (config.progress !== undefined) policy.progress = config.progress;

  return policy;
}

function optionalNullableShape<TShape extends z.ZodRawShape>(shape: TShape): {
  [K in keyof TShape]: z.ZodOptional<z.ZodNullable<TShape[K]>>;
} {
  const entries = Object.entries(shape).map(([key, schema]) => [key, (schema as z.ZodType).nullable().optional()]);
  return Object.fromEntries(entries) as { [K in keyof TShape]: z.ZodOptional<z.ZodNullable<TShape[K]>> };
}

function validateRoutingConfig(value: unknown): asserts value is Omit<RoutingProfile, "thresholds"> & {
  thresholds?: Partial<RoutingThresholds>;
} {
  if (!isPlainRecord(value)) {
    throw new Error("routing must be an object");
  }
}

function validateRoutingTerms(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}

function validateRoutingThresholdOverrides(value: unknown): asserts value is Partial<RoutingThresholds> | undefined {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    throw new Error("routing.thresholds must be an object");
  }

  const supportedThresholds = new Set(Object.keys(DEFAULT_ROUTING_THRESHOLDS));
  for (const key of Object.keys(value)) {
    if (!supportedThresholds.has(key)) {
      throw new Error(`routing.thresholds.${key} is not supported`);
    }
  }
}

function validateRoutingThresholds(thresholds: RoutingThresholds): void {
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`routing.thresholds.${key} must be a finite number between 0 and 1`);
    }
  }
}

function validatePatchConfig(
  config: unknown,
): asserts config is {
  state: z.ZodRawShape;
  model?: string | undefined;
  progress?: string | undefined;
  instruction?: string | undefined;
} {
  if (!isPlainRecord(config)) {
    throw new Error("patch config must be an object");
  }
  if (!isPlainRecord(config.state)) {
    throw new Error("patch state must be an object");
  }
  validateOptionalNonEmptyString(config.model, "patch model");
  validateOptionalNonEmptyString(config.progress, "patch progress");
  validateOptionalNonEmptyString(config.instruction, "patch instruction");

  for (const [field, schema] of Object.entries(config.state)) {
    if (RESERVED_STATE_FIELDS.has(field)) {
      throw new Error(`patch state field is reserved for runtime use: ${field}`);
    }
    if (!hasParser(schema)) {
      throw new Error(`patch state field ${field} must be a Zod schema`);
    }
  }
}

function validateOptionalNonEmptyString(value: unknown, label: string): asserts value is string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function hasParser(value: unknown): value is { parse: (input: unknown) => unknown } {
  return Boolean(value) && typeof value === "object" && typeof (value as { parse?: unknown }).parse === "function";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
