import type { WorkflowId } from "@pac/workflow";
import type { RuntimeInstance } from "../types.js";

export interface ProtocolFastPathInput {
  message: string;
  activeInstances: readonly RuntimeInstance[];
}

export interface ProtocolFastPathResult {
  action: "continue";
  targetWorkflowIds: WorkflowId[];
  reason: "ack_resolved";
  ackWorkflowId: WorkflowId;
}

/**
 * Skips the route gate only for replies that resolve an active workflow ack.
 * Input: latest message plus current active runtime instances.
 * Output: a continue decision when the message resolves protocol state.
 * Boundary: this never inspects business keywords and never selects a new workflow.
 */
export class ProtocolFastPath {
  resolve(input: ProtocolFastPathInput): ProtocolFastPathResult | undefined {
    for (const instance of input.activeInstances) {
      if (instance.context.resolveAck(input.message)) {
        return {
          action: "continue",
          targetWorkflowIds: input.activeInstances.map((item) => item.id),
          reason: "ack_resolved",
          ackWorkflowId: instance.id,
        };
      }
    }

    return undefined;
  }
}
