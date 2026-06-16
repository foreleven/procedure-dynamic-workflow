import { z } from "zod";
import {
  JsonRecordSchema,
} from "../common.js";
import type { ConnectorCatalog } from "../connectors.js";
import type {
  WorkflowDefinitionBody,
  RenderPolicy,
  WorkflowDefinition,
  WorkflowNode,
} from "../workflow.js";
import { effectDependenciesSchema } from "./program-guards.js";
import {
  errorMessage,
  isNonEmptyString,
  nonEmptyString,
  nonEmptyStringArray,
  parseSchema,
} from "../utils/schema.js";

const RESERVED_STATE_FIELDS = new Set(["messages"]);
const ROUTING_THRESHOLD_FIELDS = ["localAccept", "localUncertain", "globalAccept"] as const;

/**
 * Asserts invariants for workflow definitions that are already typed by the caller.
 * Input: a workflow definition produced by TypeScript-facing builders.
 * Output: throws when runtime-only invariants are violated.
 * Boundary: this deliberately avoids shape checks that duplicate TypeScript's contract.
 */
export function assertWorkflowDefinitionInvariants<
  TState extends object,
  TPatch,
  TConnectors extends ConnectorCatalog,
>(
  definition: WorkflowDefinition<TState, TPatch, TConnectors>,
): void {
  parseSchema(
    z.object({
      id: nonEmptyString("Workflow definition id"),
    }),
    { id: definition.id },
  );

  const label = `Workflow ${definition.id}`;
  parseSchema(workflowMetadataSchema(label), definition);
  parseSchema(routingSchema(`${label} routing`), definition.routing);
  assertWorkflowDefinitionBodyInvariants(definition, label);
}

/**
 * Asserts invariants for manifest-loaded workflow templates before metadata exists.
 * Input: workflow body produced by program-style DSL render.
 * Output: throws when state, patch, node, invalidation, or render invariants fail.
 * Boundary: identity and routing checks happen only after `agent.yaml` metadata is attached.
 */
export function assertWorkflowDefinitionTemplateInvariants<
  TState extends object,
  TPatch,
  TConnectors extends ConnectorCatalog,
>(
  body: WorkflowDefinitionBody<TState, TPatch, TConnectors>,
  label: string,
): void {
  assertWorkflowDefinitionBodyInvariants(body, label);
}

function assertWorkflowDefinitionBodyInvariants<
  TState extends object,
  TPatch,
  TConnectors extends ConnectorCatalog,
>(
  body: WorkflowDefinitionBody<TState, TPatch, TConnectors>,
  label: string,
): void {
  assertDefaultState(label, body.stateSchema, body.state);
  parseSchema(patchPolicySchema(`${label} patch`), body.patch);
  parseSchema(invalidationSchema(`${label} invalidation`), body.invalidation);
  assertWorkflowNodeInvariants(body.nodes, `${label} nodes`);
  assertRenderInvariants(body.render, `${label} render`);
}

function workflowMetadataSchema(label: string) {
  return z.object({
    version: nonEmptyString(`${label} version`),
    description: nonEmptyString(`${label} description`),
  });
}

function routingSchema(label: string) {
  return z.object({
    examples: nonEmptyStringArray(`${label}.examples`),
    entities: nonEmptyStringArray(`${label}.entities`),
    neighbors: nonEmptyStringArray(`${label}.neighbors`),
    thresholds: routingThresholdsSchema(`${label}.thresholds`),
  });
}

function routingThresholdsSchema(label: string) {
  const supportedThresholds = new Set<string>(ROUTING_THRESHOLD_FIELDS);
  return z
    .object({
      localAccept: routingThreshold(`${label}.localAccept`),
      localUncertain: routingThreshold(`${label}.localUncertain`),
      globalAccept: routingThreshold(`${label}.globalAccept`),
    })
    .passthrough()
    .superRefine((thresholds, context) => {
      for (const key of Object.keys(thresholds)) {
        if (!supportedThresholds.has(key)) {
          context.addIssue({
            code: "custom",
            message: `${label}.${key} is not supported`,
            path: [key],
          });
        }
      }
    });
}

function routingThreshold(label: string) {
  return z
    .number()
    .finite(`${label} must be a finite number between 0 and 1`)
    .min(0, `${label} must be a finite number between 0 and 1`)
    .max(1, `${label} must be a finite number between 0 and 1`);
}

function patchPolicySchema(label: string) {
  return z.object({
    instruction: nonEmptyString(`${label}.instruction`),
    model: nonEmptyString(`${label}.model`).optional(),
    progress: nonEmptyString(`${label}.progress`).optional(),
  });
}

function invalidationSchema(label: string) {
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

function workflowNodeMetadataSchema(label: string) {
  return z.object({
    name: nonEmptyString(`${label} name`),
    progress: z.string().optional(),
    description: z.string(),
  });
}

function renderPolicySchema(label: string) {
  return z.object({
    name: nonEmptyString(`${label}.name`),
    instruction: nonEmptyString(`${label}.instruction`),
    progress: nonEmptyString(`${label}.progress`),
  });
}

function assertDefaultState(
  label: string,
  stateSchema: { parse: (input: unknown) => unknown },
  state: object,
): void {
  if (!JsonRecordSchema.safeParse(state).success) {
    throw new Error(`${label} default state must be an object`);
  }
  assertNoReservedStateFields(label, "default state", state);

  let parsed: unknown;
  try {
    parsed = stateSchema.parse(state);
  } catch (error) {
    throw new Error(`${label} default state does not satisfy stateSchema: ${errorMessage(error)}`);
  }

  if (!JsonRecordSchema.safeParse(parsed).success) {
    throw new Error(`${label} default state must parse to an object`);
  }
  assertNoReservedStateFields(label, "parsed default state", parsed);
}

function assertWorkflowNodeInvariants<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  nodes: Array<WorkflowNode<TState, TConnectors>>,
  label: string,
): void {
  if (nodes.length === 0) {
    throw new Error(`${label} must contain at least one node`);
  }

  const names = new Set<string>();
  for (const node of nodes) {
    parseSchema(workflowNodeMetadataSchema(label), node);
    if (node.kind === "prefetch") {
      parseSchema(nonEmptyString(`${label} ${node.name} progress`), node.progress);
    } else if (node.progress !== undefined) {
      parseSchema(nonEmptyString(`${label} ${node.name} progress`), node.progress);
    }
    parseSchema(nonEmptyString(`${label} ${node.name} description`), node.description);
    if (node.kind === "effect" && node.dependsOn !== undefined) {
      parseSchema(effectDependenciesSchema(`${label} ${node.name} dependsOn`), node.dependsOn);
    }
    if (names.has(node.name)) {
      throw new Error(`${label} contains duplicate node name: ${node.name}`);
    }
    names.add(node.name);
  }
}

function assertRenderInvariants<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  value: WorkflowDefinition<TState, unknown, TConnectors>["render"],
  label: string,
): void {
  if (typeof value === "function") return;
  parseSchema(renderPolicySchema(label), value as RenderPolicy);
}

function assertNoReservedStateFields(workflowLabel: string, label: string, state: unknown): void {
  const parsed = JsonRecordSchema.safeParse(state);
  if (!parsed.success) return;

  for (const field of RESERVED_STATE_FIELDS) {
    if (Object.hasOwn(parsed.data, field)) {
      throw new Error(`${workflowLabel} ${label} must not define reserved ${field} field`);
    }
  }
}
