import {
  type JsonRecord,
  type WorkflowId,
  type WorkflowNode,
} from "@pac/workflow";
import type { PatchPolicy, RenderPolicy, RoutingProfile } from "@pac/workflow";
import { cloneDefault } from "../patching.js";
import type { RuntimeWorkflow, WorkflowDefinitionInput } from "../types.js";
import { errorMessage } from "../utils/errors.js";

const RESERVED_STATE_FIELDS = new Set(["messages"]);
const ROUTING_THRESHOLD_FIELDS = ["localAccept", "localUncertain", "globalAccept"] as const;
const WORKFLOW_NODE_STAGES = new Set(["beforePatch", "withPatch", "afterPatch"]);

/**
 * Finds the first duplicated string while preserving caller order.
 * Input: a readonly string list.
 * Output: the first repeated value, or undefined when every value is unique.
 * Boundary: this helper assumes callers already validated value shape.
 */
export function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }

  return undefined;
}

/**
 * Normalizes a public workflow definition into the engine's runtime shape.
 * Input: workflow definition supplied to the public engine boundary.
 * Output: parsed runtime workflow with cloneable schema-valid default state.
 * Boundary: workflow package builders validate static definition shape; this keeps only engine runtime invariants.
 */
export function toRuntimeWorkflow(candidate: WorkflowDefinitionInput): RuntimeWorkflow {
  assertWorkflowDefinitionMetadata(candidate);
  assertRoutingProfile(candidate.id, candidate.routing);
  assertPatchPolicy(candidate.id, candidate.patch);
  const nodes = candidate.nodes as Array<WorkflowNode<JsonRecord>>;
  assertWorkflowNodes(candidate.id, nodes);
  assertRenderPolicy(candidate.id, candidate.render);
  const state = parseWorkflowDefaultState(candidate.id, candidate.stateSchema, candidate.state);

  return {
    id: candidate.id,
    version: candidate.version,
    description: candidate.description,
    routing: candidate.routing,
    stateSchema: candidate.stateSchema,
    state,
    nodes,
    patch: candidate.patch,
    invalidation: candidate.invalidation,
    render: candidate.render,
  } as RuntimeWorkflow;
}

function assertWorkflowDefinitionMetadata(candidate: WorkflowDefinitionInput): void {
  assertNonEmptyString(candidate.id, "Workflow definition id");
  const label = `Workflow ${candidate.id}`;
  assertNonEmptyString(candidate.version, `${label} version`);
  assertNonEmptyString(candidate.description, `${label} description`);
}

function assertRoutingProfile(workflowId: WorkflowId, routing: RoutingProfile): void {
  const label = `Workflow ${workflowId} routing`;
  assertNonEmptyStringArray(routing.examples, `${label}.examples`);
  assertNonEmptyStringArray(routing.entities, `${label}.entities`);
  assertNonEmptyStringArray(routing.neighbors, `${label}.neighbors`);
  assertRoutingThresholds(`${label}.thresholds`, routing.thresholds);
}

function assertRoutingThresholds(label: string, thresholds: RoutingProfile["thresholds"]): void {
  if (!isRecord(thresholds)) {
    throw new Error(`${label} must be an object`);
  }

  for (const field of ROUTING_THRESHOLD_FIELDS) {
    assertRoutingThreshold(`${label}.${field}`, thresholds[field]);
  }

  for (const key of Object.keys(thresholds)) {
    if (!ROUTING_THRESHOLD_FIELDS.includes(key as (typeof ROUTING_THRESHOLD_FIELDS)[number])) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }
}

function assertRoutingThreshold(label: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
}

function assertPatchPolicy(workflowId: WorkflowId, patch: PatchPolicy<unknown>): void {
  const label = `Workflow ${workflowId} patch`;
  if (!patch || typeof patch !== "object") {
    throw new Error(`${label} must be an object`);
  }
  if (!patch.schema || typeof patch.schema.parse !== "function") {
    throw new Error(`${label}.schema must provide parse(input)`);
  }
  assertNonEmptyString(patch.instruction, `${label}.instruction`);
  if (patch.model !== undefined) assertNonEmptyString(patch.model, `${label}.model`);
  if (patch.progress !== undefined) assertNonEmptyString(patch.progress, `${label}.progress`);
}

function assertWorkflowNodes(workflowId: WorkflowId, nodes: readonly WorkflowNode<JsonRecord>[]): void {
  const label = `Workflow ${workflowId} nodes`;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`${label} must contain at least one node`);
  }

  const names = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      throw new Error(`${label} item must be an object`);
    }
    if (node.kind !== "prefetch" && node.kind !== "effect" && node.kind !== "loop") {
      throw new Error(`${label} ${String(node.name)} kind must be prefetch, effect, or loop`);
    }
    assertNonEmptyString(node.name, `${label} name`);
    if (!WORKFLOW_NODE_STAGES.has(node.stage)) {
      throw new Error(`${label} ${node.name} stage must be beforePatch, withPatch, or afterPatch`);
    }
    assertNonEmptyString(node.description, `${label} ${node.name} description`);
    if (node.kind === "prefetch") {
      assertNonEmptyString(node.progress, `${label} ${node.name} progress`);
    } else if (node.progress !== undefined) {
      assertNonEmptyString(node.progress, `${label} ${node.name} progress`);
    }
    if (node.kind === "effect" && node.dependsOn !== undefined) {
      assertNonEmptyStringArray(node.dependsOn, `${label} ${node.name} dependsOn`);
    }
    if (node.kind === "loop") {
      assertLoopNode(workflowId, node, `${label} ${node.name}`);
    } else if (typeof node.run !== "function") {
      throw new Error(`${label} ${node.name} run must be a function`);
    }
    if (node.when !== undefined && typeof node.when !== "function") {
      throw new Error(`${label} ${node.name} when must be a function`);
    }
    if (names.has(node.name)) {
      throw new Error(`${label} contains duplicate node name: ${node.name}`);
    }
    names.add(node.name);
  }
}

function assertLoopNode(workflowId: WorkflowId, node: Extract<WorkflowNode<JsonRecord>, { kind: "loop" }>, label: string): void {
  if (node.dependsOn !== undefined) {
    assertNonEmptyStringArray(node.dependsOn, `${label} dependsOn`);
  }
  if (!Number.isInteger(node.maxRuns) || node.maxRuns < 1 || node.maxRuns > 5) {
    throw new Error(`${label} maxRuns must be an integer from 1 to 5`);
  }
  if (!node.stateSchema || typeof node.stateSchema.parse !== "function") {
    throw new Error(`${label} stateSchema must provide parse(input)`);
  }
  assertNonEmptyString(node.instruction, `${label} instruction`);
  if (node.model !== undefined) assertNonEmptyString(node.model, `${label} model`);
  if (!Array.isArray(node.effects) || node.effects.length === 0) {
    throw new Error(`${label} must contain at least one loop effect`);
  }
  const effectNames = new Set<string>();
  for (const effect of node.effects) {
    assertNonEmptyString(effect.name, `${label} loop effect name`);
    assertNonEmptyString(effect.description, `${label} loop effect ${effect.name} description`);
    if (effect.dependsOn !== undefined) {
      assertNonEmptyStringArray(effect.dependsOn, `${label} loop effect ${effect.name} dependsOn`);
    }
    if (typeof effect.run !== "function") {
      throw new Error(`${label} loop effect ${effect.name} run must be a function`);
    }
    if (effectNames.has(effect.name)) {
      throw new Error(`Workflow ${workflowId} loop ${node.name} contains duplicate loop effect name: ${effect.name}`);
    }
    effectNames.add(effect.name);
  }
}

function assertRenderPolicy(
  workflowId: WorkflowId,
  render: WorkflowDefinitionInput["render"],
): void {
  if (typeof render === "function") return;
  const policy = render as RenderPolicy;
  const label = `Workflow ${workflowId} render`;
  if (!policy || typeof policy !== "object") {
    throw new Error(`${label} must be a function or render policy`);
  }
  assertNonEmptyString(policy.name, `${label}.name`);
  assertNonEmptyString(policy.instruction, `${label}.instruction`);
  assertNonEmptyString(policy.progress, `${label}.progress`);
}

function parseWorkflowDefaultState(
  workflowId: WorkflowId,
  stateSchema: { parse: (input: unknown) => unknown },
  state: unknown,
): JsonRecord {
  assertNoReservedStateFields(workflowId, "default state", state);

  let cloned: unknown;
  try {
    cloned = cloneDefault(state);
  } catch (error) {
    throw new Error(`Workflow ${workflowId} default state is not cloneable: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = stateSchema.parse(cloned);
  } catch (error) {
    throw new Error(`Workflow ${workflowId} default state does not satisfy stateSchema: ${errorMessage(error)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Workflow ${workflowId} default state must parse to an object`);
  }
  assertNoReservedStateFields(workflowId, "parsed default state", parsed);

  return parsed;
}

function assertNoReservedStateFields(workflowId: WorkflowId, label: string, state: unknown): void {
  if (!isRecord(state)) return;
  for (const field of RESERVED_STATE_FIELDS) {
    if (Object.hasOwn(state, field)) {
      throw new Error(`Workflow ${workflowId} ${label} must not define reserved ${field} field`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPlainObject(value: unknown): value is JsonRecord {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertNonEmptyStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}
