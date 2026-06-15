import type { JsonRecord, WorkflowId, WorkflowInstance } from "@pac/workflow";
import { WorkflowInstanceStore } from "../runtime/instances.js";
import type { EngineSession, TargetSelection } from "../types.js";
import type { WorkflowRoutingResult } from "./router.js";

export interface RoutingPlanApplyInput {
  session: EngineSession;
  instances: WorkflowInstanceStore;
  activeInstances: readonly WorkflowInstance<JsonRecord>[];
  result: WorkflowRoutingResult;
}

/**
 * Applies a validated route plan to session routing state and runtime instances.
 * Input: current active workflow ids plus a route result.
 * Output: target runtime instances for this turn.
 * Boundary: this mutates only routing/session lifecycle state; workflow state changes stay in WorkflowEngine.
 */
export class RoutingPlanApplier {
  apply(input: RoutingPlanApplyInput): TargetSelection {
    const previousActiveIds = input.activeInstances.map((instance) => instance.id);
    const targetIds = unique(input.result.targetWorkflowIds);

    if (input.result.action === "switch" || input.result.action === "parallel") {
      input.session.activeWorkflowIds = targetIds;
    }

    if (input.result.action === "switch") {
      const suspended = unique([
        ...(input.session.routingMemory.suspendedWorkflowIds ?? []),
        ...previousActiveIds.filter((id) => !targetIds.includes(id)),
      ]).filter((id) => !targetIds.includes(id));
      if (suspended.length > 0) {
        input.session.routingMemory.suspendedWorkflowIds = suspended;
      } else {
        delete input.session.routingMemory.suspendedWorkflowIds;
      }
    } else if (targetIds.length > 0 && input.session.routingMemory.suspendedWorkflowIds) {
      const suspended = input.session.routingMemory.suspendedWorkflowIds.filter((id) => !targetIds.includes(id));
      if (suspended.length > 0) {
        input.session.routingMemory.suspendedWorkflowIds = suspended;
      } else {
        delete input.session.routingMemory.suspendedWorkflowIds;
      }
    }

    input.session.routingMemory.lastMatchedWorkflowIds = targetIds;
    input.session.routingMemory.lastRoutingAction = input.result.action;

    for (const targetId of targetIds) {
      input.instances.attach(input.session, targetId);
    }

    const targetSet = new Set(targetIds);
    return {
      instances: input.instances.forIds(input.session, targetIds),
      ids: targetSet,
    };
  }
}

function unique(ids: readonly WorkflowId[]): WorkflowId[] {
  return [...new Set(ids)];
}
