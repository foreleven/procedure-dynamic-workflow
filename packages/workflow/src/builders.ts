import { z } from "zod";
import {
  JsonRecordSchema,
  type RoutingProfile,
  type RoutingThresholds,
} from "./common.js";
import {
  nonEmptyString,
  nonEmptyStringArray,
  parseSchema,
  zodSchema,
} from "./utils/schema.js";

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
  parseSchema(routingInputSchema(), routing);

  const thresholds = {
    ...DEFAULT_ROUTING_THRESHOLDS,
    ...routing.thresholds,
  };
  parseSchema(routingThresholdsSchema(), thresholds);

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
  parseSchema(patchConfigSchema(), config);
  assertPatchStateInvariants(config.state);
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

function routingInputSchema() {
  return z.object(
    {
      examples: nonEmptyStringArray("routing.examples"),
      entities: nonEmptyStringArray("routing.entities"),
      neighbors: nonEmptyStringArray("routing.neighbors"),
      thresholds: routingThresholdOverridesSchema().optional(),
    },
    { message: "routing must be an object" },
  );
}

function routingThresholdOverridesSchema() {
  const supportedThresholds = new Set(Object.keys(DEFAULT_ROUTING_THRESHOLDS));
  return z
    .record(z.string(), z.unknown(), { message: "routing.thresholds must be an object" })
    .superRefine((thresholds, context) => {
      for (const key of Object.keys(thresholds)) {
        if (!supportedThresholds.has(key)) {
          context.addIssue({
            code: "custom",
            message: `routing.thresholds.${key} is not supported`,
            path: [key],
          });
        }
      }
    });
}

function routingThresholdsSchema() {
  return z.object({
    localAccept: routingThreshold("routing.thresholds.localAccept"),
    localUncertain: routingThreshold("routing.thresholds.localUncertain"),
    globalAccept: routingThreshold("routing.thresholds.globalAccept"),
  });
}

function routingThreshold(label: string) {
  return z
    .number()
    .finite(`${label} must be a finite number between 0 and 1`)
    .min(0, `${label} must be a finite number between 0 and 1`)
    .max(1, `${label} must be a finite number between 0 and 1`);
}

function patchConfigSchema() {
  return z.object(
    {
      state: z.record(z.string(), z.unknown(), { message: "patch state must be an object" }),
      model: nonEmptyString("patch model").optional(),
      progress: nonEmptyString("patch progress").optional(),
      instruction: nonEmptyString("patch instruction").optional(),
    },
    { message: "patch config must be an object" },
  );
}

function assertPatchStateInvariants(state: z.ZodRawShape): void {
  for (const [field, schema] of Object.entries(state)) {
    if (RESERVED_STATE_FIELDS.has(field)) {
      throw new Error(`patch state field is reserved for runtime use: ${field}`);
    }
    parseSchema(zodSchema(`patch state field ${field}`, `patch state field ${field} must be a Zod schema`), schema);
  }
}
