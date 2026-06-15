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
  clarification?: string | undefined;
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
