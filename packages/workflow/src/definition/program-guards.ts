import { z } from "zod";
import type { ConnectorCatalog } from "../connectors.js";
import type {
  ProgramRenderConfig,
  ProgramWorkflowConfig,
  ProgramWorkflowTemplateConfig,
} from "../program.js";
import type { WorkflowNode } from "../workflow.js";
import {
  isNonEmptyString,
  nonEmptyString,
  parseSchema,
  zodSchema,
} from "../utils/schema.js";

/**
 * Asserts program-style workflow config invariants before node registration starts.
 * Input: typed program workflow config.
 * Output: throws a stable definition-time error when runtime-only invariants fail.
 * Boundary: this does not duplicate TypeScript's shape checks.
 */
export function assertProgramWorkflowInvariants<TState extends object>(
  value: ProgramWorkflowConfig<TState> | ProgramWorkflowTemplateConfig<TState>,
): void {
  if (!("id" in value)) {
    assertPatchInvalidationInvariants(value.invalidation, "Workflow template invalidation");
    return;
  }

  parseSchema(z.object({ id: nonEmptyString("Workflow program id") }), value);
  const label = `Workflow ${value.id}`;
  parseSchema(
    z.object({
      version: nonEmptyString(`${label} version`),
      description: nonEmptyString(`${label} description`),
    }),
    value,
  );
  assertPatchInvalidationInvariants(value.invalidation, `${label} invalidation`);
}

export function assertProgramNodeInvariants(
  name: string,
  config: { progress?: string | undefined; description: string },
  label: string,
  options: { requireProgress?: boolean } = {},
): void {
  parseSchema(nonEmptyString(`${label} name`), name);
  const progressSchema = options.requireProgress
    ? nonEmptyString(`${label} ${name} progress`)
    : nonEmptyString(`${label} ${name} progress`).optional();
  parseSchema(
    z.object({
      progress: progressSchema,
      description: nonEmptyString(`${label} ${name} description`),
    }),
    config,
  );
}

export function assertProgramLoopConfigInvariants(
  config: { maxRuns: number; stateSchema: z.ZodType; instruction: string; model?: string | undefined },
  label: string,
): void {
  parseSchema(
    z.object({
      maxRuns: z.number().int(`${label} maxRuns must be an integer from 1 to 5`)
        .min(1, `${label} maxRuns must be an integer from 1 to 5`)
        .max(5, `${label} maxRuns must be an integer from 1 to 5`),
      stateSchema: zodSchema(`${label} stateSchema`, `${label} stateSchema must be a Zod schema`),
      instruction: nonEmptyString(`${label} instruction`),
      model: nonEmptyString(`${label} model`).optional(),
    }),
    config,
  );
}

/**
 * Validates state dependency metadata before effect nodes are registered.
 * Input: optional dependency field list from the program DSL.
 * Output: throws when a dependency is blank, duplicated, or targets runtime-reserved state.
 * Boundary: state-schema membership remains a TypeScript concern for typed workflows.
 */
export function assertProgramEffectDependencies(
  value: readonly string[] | undefined,
  label: string,
): void {
  if (value === undefined) return;
  parseSchema(effectDependenciesSchema(label), value);
}

export function assertProgramLoopEffectDependencies(
  value: readonly string[] | undefined,
  label: string,
): void {
  if (value === undefined) return;
  parseSchema(loopEffectDependenciesSchema(label), value);
}

export function assertProgramNodeStage<TState extends object, TConnectors extends ConnectorCatalog>(
  node: WorkflowNode<TState, TConnectors>,
  label: string,
): void {
  if (node.stage !== "withPatch" && node.stage !== "afterPatch") {
    throw new Error(`${label} ${node.name} stage must be withPatch or afterPatch`);
  }
}

export function assertRenderConfigInvariants(value: ProgramRenderConfig, label: string): void {
  parseSchema(
    z.object({
      name: nonEmptyString(`${label} name`),
      instruction: nonEmptyString(`${label} instruction`),
      progress: nonEmptyString(`${label} progress`),
    }),
    value,
  );
}

export function assertPatchInvalidationInvariants(
  value: Partial<Record<string, string[]>> | undefined,
  label: string,
): void {
  if (value === undefined) return;
  parseSchema(patchInvalidationSchema(label), value);
}

export function effectDependenciesSchema(label: string) {
  return z.array(z.string()).superRefine((dependencies, context) => {
    const seen = new Set<string>();
    for (const [index, dependency] of dependencies.entries()) {
      if (!isNonEmptyString(dependency)) {
        context.addIssue({
          code: "custom",
          message: `${label} must contain only non-empty strings`,
          path: [index],
        });
        continue;
      }
      if (dependency === "messages") {
        context.addIssue({
          code: "custom",
          message: `${label} must not include reserved messages state`,
          path: [index],
        });
        continue;
      }
      if (seen.has(dependency)) {
        context.addIssue({
          code: "custom",
          message: `${label} must not contain duplicate fields`,
          path: [index],
        });
        continue;
      }
      seen.add(dependency);
    }
  });
}

export function loopEffectDependenciesSchema(label: string) {
  return z.array(z.string()).superRefine((dependencies, context) => {
    const seen = new Set<string>();
    for (const [index, dependency] of dependencies.entries()) {
      if (!isNonEmptyString(dependency)) {
        context.addIssue({
          code: "custom",
          message: `${label} must contain only non-empty strings`,
          path: [index],
        });
        continue;
      }
      if (seen.has(dependency)) {
        context.addIssue({
          code: "custom",
          message: `${label} must not contain duplicate dependencies`,
          path: [index],
        });
        continue;
      }
      seen.add(dependency);
    }
  });
}

function patchInvalidationSchema(label: string) {
  return z
    .record(z.string(), z.array(z.string()))
    .superRefine((invalidation, context) => {
      for (const [field, dependents] of Object.entries(invalidation)) {
        if (!isNonEmptyString(field)) {
          context.addIssue({
            code: "custom",
            message: `${label} field must be a non-empty string`,
            path: [field],
          });
          continue;
        }
        if (dependents.length === 0 || !dependents.every(isNonEmptyString)) {
          context.addIssue({
            code: "custom",
            message: `${label}.${field} must be an array of non-empty strings`,
            path: [field],
          });
        }
      }
    });
}
