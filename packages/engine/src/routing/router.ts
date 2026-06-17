/**
 * Routing contract and defensive result boundary.
 *
 * Routers may be custom extension code, so their output is treated as unknown
 * until normalized here. The normalized plan is the only shape allowed to mutate
 * engine session lifecycle state.
 */
import type { JsonRecord, WorkflowId, WorkflowInstance, WorkflowMessage } from "@pac/workflow";
import type { EngineSession, RuntimeWorkflow } from "../types.js";

export type RoutingAction = "continue" | "switch" | "parallel" | "clarify" | "none";

export interface WorkflowRoutingInput {
  message: string;
  session: EngineSession;
  workflows: readonly RuntimeWorkflow[];
  activeInstances: readonly WorkflowInstance<JsonRecord>[];
  recentMessages: readonly WorkflowMessage[];
}

export interface WorkflowRoutingResult {
  action: RoutingAction;
  targetWorkflowIds: WorkflowId[];
  suspendedWorkflowIds: WorkflowId[];
  detail?: unknown;
}

/**
 * Selects the workflow ids that should run for one user turn.
 * Input: the latest message, session routing memory, workflow profiles, and active instances.
 * Output: a validated workflow-level routing plan.
 * Boundary: routers never mutate workflow state, call connectors, extract business fields, or render replies.
 */
export abstract class WorkflowRouter {
  abstract route(input: WorkflowRoutingInput): Promise<WorkflowRoutingResult>;
}

/**
 * Sanitizes router extension output before it can mutate engine-owned session state.
 * Input: raw router output, active workflow ids, and the engine registry id set.
 * Output: a safe routing plan that fails closed on malformed or unknown workflow ids.
 * Boundary: routers choose intent; the engine remains owner of runtime lifecycle mutation.
 */
export function normalizeWorkflowRoutingResult(
  result: unknown,
  activeWorkflowIds: readonly WorkflowId[],
  knownWorkflowIds: ReadonlySet<WorkflowId>,
): WorkflowRoutingResult {
  const mode = activeWorkflowIds.length > 0 ? "existing_session" : "new_session";
  if (!isRoutingResultRecord(result)) {
    return failClosedRoutingResult(mode, { reason: "invalid_router_result" });
  }

  const action = isRoutingAction(result.action) ? result.action : undefined;
  const targetIds = stringArray(result.targetWorkflowIds);
  const suspendedIds = stringArray(result.suspendedWorkflowIds);
  if (!action || !targetIds || !suspendedIds) {
    return failClosedRoutingResult(mode, { reason: "invalid_router_result" });
  }

  const unknownWorkflowIds = uniqueWorkflowIds([...targetIds, ...suspendedIds])
    .filter((workflowId) => !knownWorkflowIds.has(workflowId));
  if (unknownWorkflowIds.length > 0) {
    return failClosedRoutingResult(mode, {
      reason: "unknown_workflow_ids",
      unknownWorkflowIds,
    });
  }

  if (action === "continue") {
    const requestedTargets = targetIds.length > 0 ? uniqueWorkflowIds(targetIds) : activeWorkflowIds;
    const nonActiveTargets = requestedTargets.filter((workflowId) => !activeWorkflowIds.includes(workflowId));
    if (activeWorkflowIds.length === 0 || nonActiveTargets.length > 0) {
      return failClosedRoutingResult(mode, {
        reason: "invalid_continue_targets",
        targetWorkflowIds: requestedTargets,
      });
    }

    return routingResult("continue", [...activeWorkflowIds], [], result.detail);
  }

  if (action === "switch") {
    const normalizedTargets = uniqueWorkflowIds(targetIds);
    if (normalizedTargets.length === 0) {
      return failClosedRoutingResult(mode, { reason: "switch_without_targets" });
    }

    return routingResult("switch", normalizedTargets, suspendedIds, result.detail);
  }

  if (action === "parallel") {
    const normalizedTargets = uniqueWorkflowIds([...activeWorkflowIds, ...targetIds]);
    if (targetIds.length === 0 || normalizedTargets.length === 0) {
      return failClosedRoutingResult(mode, { reason: "parallel_without_targets" });
    }

    return routingResult("parallel", normalizedTargets, [], result.detail);
  }

  if (action === "clarify") {
    return routingResult("clarify", [], [], result.detail);
  }

  return routingResult("none", [], [], result.detail);
}

type RoutingMode = "new_session" | "existing_session";

function isRoutingResultRecord(value: unknown): value is Partial<WorkflowRoutingResult> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRoutingAction(value: unknown): value is WorkflowRoutingResult["action"] {
  return (
    value === "continue" ||
    value === "switch" ||
    value === "parallel" ||
    value === "clarify" ||
    value === "none"
  );
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function failClosedRoutingResult(mode: RoutingMode, detail: unknown): WorkflowRoutingResult {
  return routingResult(mode === "existing_session" ? "clarify" : "none", [], [], detail);
}

function routingResult(
  action: WorkflowRoutingResult["action"],
  targetWorkflowIds: WorkflowId[],
  suspendedWorkflowIds: WorkflowId[],
  detail: unknown,
): WorkflowRoutingResult {
  return {
    action,
    targetWorkflowIds,
    suspendedWorkflowIds,
    ...(detail === undefined ? {} : { detail }),
  };
}

function uniqueWorkflowIds(ids: readonly WorkflowId[]): WorkflowId[] {
  return [...new Set(ids)];
}
