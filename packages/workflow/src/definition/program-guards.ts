import { z } from "zod";
import type { ConnectorCatalog } from "../connectors.js";
import type {
  ProgramRenderConfig,
  ProgramWorkflowConfig,
} from "../program.js";
import type { WorkflowNode } from "../workflow.js";
import {
  isNonEmptyString,
  nonEmptyString,
  parseSchema,
} from "../utils/schema.js";

/**
 * Asserts program-style workflow metadata invariants before node registration starts.
 * Input: typed program workflow config.
 * Output: throws a stable definition-time error when runtime-only invariants fail.
 * Boundary: this does not duplicate TypeScript's shape checks.
 */
export function assertProgramWorkflowInvariants<TState extends object>(
  value: ProgramWorkflowConfig<TState>,
): void {
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
  config: { progress: string; description: string },
  label: string,
): void {
  parseSchema(nonEmptyString(`${label} name`), name);
  parseSchema(
    z.object({
      progress: nonEmptyString(`${label} ${name} progress`),
      description: nonEmptyString(`${label} ${name} description`),
    }),
    config,
  );
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
