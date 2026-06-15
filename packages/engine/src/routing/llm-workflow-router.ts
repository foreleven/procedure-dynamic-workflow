import type { WorkflowId } from "@pac/workflow";
import type { EngineSession } from "../types.js";
import { AllWorkflowCandidateProvider, type WorkflowCandidateProvider } from "./candidate-provider.js";
import { ProtocolFastPath } from "./protocol-fast-path.js";
import { FlashLlmRouteGate, type PendingAckProfile, type RouteGate } from "./route-gate.js";
import type { RoutingAction, WorkflowRouter, WorkflowRoutingInput, WorkflowRoutingResult } from "./router.js";
import type { RawRouteGateDecision } from "./schemas.js";
import { workflowRoutingProfile, type WorkflowRoutingProfile } from "./workflow-profile.js";
import type { LlmClient } from "../llm/client.js";
import { errorMessage } from "../utils/errors.js";

export interface LlmWorkflowRouterOptions {
  llm: LlmClient;
  gate?: RouteGate | undefined;
  candidateProvider?: WorkflowCandidateProvider | undefined;
  gateModel?: string | undefined;
  minGateConfidence?: number | undefined;
  maxWorkflowProfiles?: number | undefined;
  recentMessageLimit?: number | undefined;
}

/**
 * Routes each turn through protocol fast path plus a structured LLM workflow gate.
 * Input: current session, active workflows, recent messages, and registered workflows.
 * Output: validated per-turn workflow target ids.
 * Boundary: this owns workflow choice only; WorkflowEngine owns applying patches and executing nodes.
 */
export class LlmWorkflowRouter implements WorkflowRouter {
  private readonly gate: RouteGate;
  private readonly candidateProvider: WorkflowCandidateProvider;
  private readonly protocolFastPath = new ProtocolFastPath();
  private readonly minGateConfidence: number;

  constructor(options: LlmWorkflowRouterOptions) {
    this.gate = options.gate ?? new FlashLlmRouteGate(options.llm, { model: options.gateModel });
    this.candidateProvider = options.candidateProvider
      ?? new AllWorkflowCandidateProvider({ maxWorkflowProfiles: options.maxWorkflowProfiles });
    this.minGateConfidence = options.minGateConfidence ?? 0.72;
  }

  async route(input: WorkflowRoutingInput): Promise<WorkflowRoutingResult> {
    const activeWorkflowIds = input.activeInstances.map((instance) => instance.id);
    const mode = activeWorkflowIds.length > 0 ? "existing_session" : "new_session";

    if (mode === "existing_session") {
      const fastPath = this.protocolFastPath.resolve({
        message: input.message,
        activeInstances: input.activeInstances,
      });
      if (fastPath) {
        return {
          action: "continue",
          targetWorkflowIds: fastPath.targetWorkflowIds,
          suspendedWorkflowIds: [],
          detail: { reason: fastPath.reason, ackWorkflowId: fastPath.ackWorkflowId },
        };
      }
    }

    const candidates = await this.candidateProvider.getCandidates({
      message: input.message,
      workflows: input.workflows,
      activeWorkflowIds,
      lastMatchedWorkflowIds: input.session.routingMemory.lastMatchedWorkflowIds,
    });
    const activeProfiles = input.activeInstances.map((instance) => workflowRoutingProfile(instance.artifact));
    let decision: RawRouteGateDecision;
    try {
      decision = await this.gate.decide({
        latestUserMessage: input.message,
        mode,
        activeWorkflows: activeProfiles,
        candidateWorkflows: candidates,
        pendingAcks: pendingAckProfiles(input.activeInstances),
        session: input.session,
        recentMessages: input.recentMessages,
      });
    } catch (error) {
      return gateFailure(mode, error);
    }

    return validateDecision({
      decision,
      mode,
      session: input.session,
      candidateProfiles: candidates,
      activeWorkflowIds,
      minGateConfidence: this.minGateConfidence,
    });
  }
}

interface ValidateDecisionInput {
  decision: RawRouteGateDecision;
  mode: "new_session" | "existing_session";
  session: EngineSession;
  candidateProfiles: readonly WorkflowRoutingProfile[];
  activeWorkflowIds: readonly WorkflowId[];
  minGateConfidence: number;
}

function validateDecision(input: ValidateDecisionInput): WorkflowRoutingResult {
  const knownWorkflowIds = new Set(input.candidateProfiles.map((profile) => profile.id));
  const targetIds = unique(input.decision.targetWorkflowIds).filter((id) => knownWorkflowIds.has(id));
  const invalidTargetIds = input.decision.targetWorkflowIds.filter((id) => !knownWorkflowIds.has(id));
  const action = normalizeAction(input.decision.action, input.mode, targetIds, input.activeWorkflowIds);

  if (input.decision.confidence < input.minGateConfidence) {
    return failClosed(input, action, targetIds, { reason: "low_confidence" });
  }

  if (invalidTargetIds.length > 0) {
    return failClosed(input, action, targetIds, { reason: "unknown_workflow_ids", invalidTargetIds });
  }

  if (action === "continue") {
    if (input.activeWorkflowIds.length === 0) return none(input, { reason: "continue_without_active" });
    return result("continue", [...input.activeWorkflowIds], [], input);
  }

  if (action === "switch") {
    if (targetIds.length === 0) return none(input, { reason: "switch_without_targets" });
    return result("switch", targetIds, suspendedFrom(input.activeWorkflowIds, targetIds), input);
  }

  if (action === "parallel") {
    if (targetIds.length === 0) return clarify(input, { reason: "parallel_without_targets" });
    const mergedTargets = unique([...input.activeWorkflowIds, ...targetIds]);
    return result("parallel", mergedTargets, [], input);
  }

  if (action === "clarify") {
    return result("clarify", [], [], input);
  }

  return none(input);
}

function normalizeAction(
  action: RoutingAction,
  mode: "new_session" | "existing_session",
  targetIds: readonly WorkflowId[],
  activeWorkflowIds: readonly WorkflowId[],
): RoutingAction {
  if (mode === "new_session" && targetIds.length > 0) return "switch";
  if (mode === "new_session" && action === "continue") return targetIds.length > 0 ? "switch" : "none";
  if (action === "continue" && activeWorkflowIds.length === 0) return targetIds.length > 0 ? "switch" : "none";
  return action;
}

function failClosed(
  input: ValidateDecisionInput,
  requestedAction: RoutingAction,
  targetIds: readonly WorkflowId[],
  detail: unknown,
): WorkflowRoutingResult {
  if (input.mode === "existing_session" && requestedAction !== "none") {
    return {
      ...clarify(input, detail),
      detail,
    };
  }

  if (targetIds.length > 0 && input.mode === "new_session") {
    return none(input, detail);
  }

  return none(input, detail);
}

function none(input: ValidateDecisionInput, detail?: unknown): WorkflowRoutingResult {
  return {
    ...result("none", [], [], input),
    detail,
  };
}

function clarify(input: ValidateDecisionInput, detail?: unknown): WorkflowRoutingResult {
  return {
    ...result("clarify", [], [], input),
    detail,
  };
}

function result(
  action: RoutingAction,
  targetWorkflowIds: WorkflowId[],
  suspendedWorkflowIds: WorkflowId[],
  input: ValidateDecisionInput,
): WorkflowRoutingResult {
  return {
    action,
    targetWorkflowIds,
    suspendedWorkflowIds,
    detail: {
      reason: input.decision.reason,
      confidence: input.decision.confidence,
      requestedAction: input.decision.action,
    },
  };
}

function gateFailure(
  mode: "new_session" | "existing_session",
  error: unknown,
): WorkflowRoutingResult {
  return {
    action: mode === "existing_session" ? "clarify" : "none",
    targetWorkflowIds: [],
    suspendedWorkflowIds: [],
    detail: {
      reason: "route_gate_failed",
      error: errorMessage(error),
    },
  };
}

function pendingAckProfiles(instances: readonly { id: WorkflowId; context: { getAck(): unknown } }[]): PendingAckProfile[] {
  const profiles: PendingAckProfile[] = [];
  for (const instance of instances) {
    const ack = instance.context.getAck();
    if (!ack || typeof ack !== "object") continue;
    const record = ack as {
      id?: unknown;
      prompt?: unknown;
      options?: unknown;
    };
    if (typeof record.id !== "string" || typeof record.prompt !== "string" || !Array.isArray(record.options)) {
      continue;
    }

    profiles.push({
      workflowId: instance.id,
      id: record.id,
      prompt: record.prompt,
      optionLabels: record.options.flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const label = (option as { label?: unknown }).label;
        return typeof label === "string" ? [label] : [];
      }),
    });
  }

  return profiles;
}

function suspendedFrom(activeWorkflowIds: readonly WorkflowId[], targetIds: readonly WorkflowId[]): WorkflowId[] {
  return activeWorkflowIds.filter((id) => !targetIds.includes(id));
}

function unique(ids: readonly WorkflowId[]): WorkflowId[] {
  return [...new Set(ids)];
}
