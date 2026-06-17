import type { WorkflowId, WorkflowMessage } from "@pac/workflow";
import type { Message } from "@earendil-works/pi-ai";
import type { LlmClient } from "../llm/client.js";
import type { EngineSession } from "../types.js";
import { safeJsonStringify } from "../utils/json.js";
import { RouteGateDecisionSchema, type RawRouteGateDecision } from "./schemas.js";
import type { WorkflowRoutingProfile } from "./workflow-profile.js";

export interface PendingAckProfile {
  workflowId: WorkflowId;
  id: string;
  prompt: string;
  optionLabels: string[];
}

export interface RouteGateInput {
  latestUserMessage: string;
  mode: "new_session" | "existing_session";
  activeWorkflows: readonly WorkflowRoutingProfile[];
  candidateWorkflows: readonly WorkflowRoutingProfile[];
  pendingAcks: readonly PendingAckProfile[];
  session: Pick<
    EngineSession,
    "sessionId" | "userId" | "goals" | "constraints" | "conversationSummary" | "routingMemory"
  >;
  recentMessages: readonly WorkflowMessage[];
}

export abstract class RouteGate {
  abstract decide(input: RouteGateInput): Promise<RawRouteGateDecision>;
}

export interface FlashLlmRouteGateOptions {
  model?: string | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Uses the configured LLM as a low-latency structured workflow-level route gate.
 * Input: compact workflow profiles plus session memory and recent messages.
 * Output: schema-validated route action and target workflow ids.
 * Boundary: the gate cannot extract business state, call connectors, or compose user-visible text.
 */
export class FlashLlmRouteGate extends RouteGate {
  constructor(
    private readonly llm: LlmClient,
    private readonly options: FlashLlmRouteGateOptions = {},
  ) {
    super();
  }

  async decide(input: RouteGateInput): Promise<RawRouteGateDecision> {
    return this.llm.structured({
      name: "workflow_route",
      ...(this.options.model ? { model: this.options.model } : {}),
      instruction: routeGateInstruction(input.mode),
      schema: RouteGateDecisionSchema,
      messages: routeGateMessages(input, this.options.now),
    });
  }
}

function routeGateInstruction(mode: RouteGateInput["mode"]): string {
  const modeInstruction = mode === "new_session"
    ? [
        "This is a new session. Select workflow(s) before any workflow runs.",
        "Use action switch with targetWorkflowIds for selected workflow(s).",
        "Use action none only when no workflow, including fallback chat workflow, should run.",
      ]
    : [
        "This is an existing session. Decide whether the latest message continues active workflow(s), switches, runs in parallel, clarifies, or runs no workflow.",
        "Use action continue when the user is still advancing the current active workflow(s).",
        "Use action switch when the user has moved to a new task that should replace current active workflow(s).",
        "Use action parallel when the user starts an additional task while preserving current active workflow(s).",
      ];

  return [
    "PAC workflow routing gate:",
    "- Decide only at workflow level.",
    "- Do not extract business fields, state patches, records, prices, availability, or external facts.",
    "- Do not generate user-visible replies.",
    "- Do not call tools or connectors.",
    "- Do not switch just because entities are similar; select by task intent.",
    "- If a fallback chat workflow is selected, return it as a normal target workflow with switch or parallel, not none.",
    "- Keep targetWorkflowIds minimal but include every workflow needed for clearly mixed intent.",
    "- Set suspendedWorkflowIds only to active workflow ids that should pause; the engine will recompute it.",
    ...modeInstruction,
  ].join("\n");
}

function routeGateMessages(input: RouteGateInput, now: (() => Date) | undefined): Message[] {
  return [
    {
      role: "user",
      timestamp: timestampNow(now),
      content: safeJsonStringify(
        {
          latestUserMessage: input.latestUserMessage,
          mode: input.mode,
          session: {
            sessionId: input.session.sessionId,
            userId: input.session.userId,
            goals: input.session.goals,
            constraints: input.session.constraints,
            conversationSummary: input.session.conversationSummary,
            routingMemory: input.session.routingMemory,
          },
          activeWorkflows: input.activeWorkflows,
          candidateWorkflows: input.candidateWorkflows,
          pendingAcks: input.pendingAcks,
          recentMessages: input.recentMessages,
        },
        2,
      ),
    },
  ];
}

function timestampNow(now: (() => Date) | undefined): number {
  return (now?.() ?? new Date()).getTime();
}
