import {
  type JsonRecord,
  type WorkflowId,
  type WorkflowNode,
} from "@pac/workflow";
import { cloneDefault } from "../patching.js";
import type { RuntimeWorkflow, WorkflowDefinitionInput } from "../types.js";
import { errorMessage } from "../utils/errors.js";

const RESERVED_STATE_FIELDS = new Set(["messages"]);

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
  const nodes = candidate.nodes as Array<WorkflowNode<JsonRecord>>;
  const state = parseWorkflowDefaultState(candidate.id, candidate.stateSchema, candidate.state);

  if (nodes.length === 0) {
    throw new Error(`Workflow ${candidate.id} must define at least one node`);
  }

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
