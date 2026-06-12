import { z } from "zod";
import {
  JsonRecordSchema,
  type RoutingProfile,
  type RoutingThresholds,
} from "./common.js";

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
  return {
    examples: routing.examples,
    entities: routing.entities,
    neighbors: routing.neighbors,
    thresholds: {
      ...DEFAULT_ROUTING_THRESHOLDS,
      ...routing.thresholds,
    },
  };
}

const DEFAULT_PATCH_INSTRUCTION = `
Extract only structured updates.
Do not reason step by step.
Do not generate final response.
`;

export interface PatchPolicy<TPatch = unknown> {
  model?: string;
  progress?: string;
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
    model?: string;
    progress?: string;
    instruction?: string;
  },
): PatchPolicy<PatchOutput<TStatePatchShape>> {
  return {
    model: config.model,
    progress: config.progress,
    schema: patchSchema(config.state),
    instruction: config.instruction ?? DEFAULT_PATCH_INSTRUCTION,
  };
}

function optionalNullableShape<TShape extends z.ZodRawShape>(shape: TShape): {
  [K in keyof TShape]: z.ZodOptional<z.ZodNullable<TShape[K]>>;
} {
  const entries = Object.entries(shape).map(([key, schema]) => [key, (schema as z.ZodType).nullable().optional()]);
  return Object.fromEntries(entries) as { [K in keyof TShape]: z.ZodOptional<z.ZodNullable<TShape[K]>> };
}
