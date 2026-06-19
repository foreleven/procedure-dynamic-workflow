import type {
  JsonRecord,
  MaybePromise,
  PatchPolicy,
  RenderPolicy,
  RenderResponse,
  RoutingProfile,
  SessionContext,
  WorkflowDefinition,
  WorkflowDeps,
  WorkflowId,
  WorkflowMessage,
  WorkflowNodeStage,
  WorkflowRuntimeState,
  WorkflowUserMessage,
} from "@pac/workflow";
import type { LlmClient } from "./llm/client.js";
import type { RouteGate } from "./routing/route-gate.js";
import type { WorkflowCandidateProvider } from "./routing/candidate-provider.js";
import type { WorkflowRouter } from "./routing/router.js";

export type RuntimeWorkflow = WorkflowDefinition<JsonRecord, unknown>;

interface WorkflowDefinitionNodeBaseInput {
  name: string;
  stage: WorkflowNodeStage;
  progress?: string | undefined;
  description: string;
}

export interface WorkflowDefinitionPrefetchNodeInput extends WorkflowDefinitionNodeBaseInput {
  kind: "prefetch";
  when?: (input: never) => MaybePromise<boolean>;
  run: (input: never) => MaybePromise<unknown>;
}

export interface WorkflowDefinitionEffectNodeInput extends WorkflowDefinitionNodeBaseInput {
  kind: "effect";
  dependsOn?: readonly string[];
  when?: (input: never) => MaybePromise<boolean>;
  run: (input: never) => MaybePromise<unknown>;
}

export interface WorkflowDefinitionLoopEffectInput {
  name: string;
  description: string;
  dependsOn?: readonly string[];
  run: (input: never, loop: never) => MaybePromise<unknown>;
}

export interface WorkflowDefinitionLoopNodeInput extends WorkflowDefinitionNodeBaseInput {
  kind: "loop";
  dependsOn?: readonly string[];
  maxRuns: number;
  stateSchema: { parse(input: unknown): object };
  instruction: string;
  model?: string | undefined;
  effects: readonly WorkflowDefinitionLoopEffectInput[];
}

export type WorkflowDefinitionNodeInput =
  | WorkflowDefinitionPrefetchNodeInput
  | WorkflowDefinitionEffectNodeInput
  | WorkflowDefinitionLoopNodeInput;

export interface WorkflowDefinitionInput {
  id: string;
  version: string;
  description: string;
  routing: RoutingProfile;
  stateSchema: { parse(input: unknown): object };
  state: object;
  nodes: WorkflowDefinitionNodeInput[];
  patch: PatchPolicy<unknown>;
  invalidation: Partial<Record<string, string[]>>;
  render: RenderPolicy | ((input: never) => MaybePromise<RenderResponse>);
}

export type EngineSession = SessionContext;

export interface WorkflowSnapshot<TState extends object = JsonRecord> {
  id: WorkflowId;
  version: string;
  state: WorkflowRuntimeState<TState>;
  context: JsonRecord;
  prefetch: JsonRecord;
}

export interface CreateSessionInput {
  sessionId: string;
  userId: string;
  activeWorkflowIds?: WorkflowId[];
  messages?: WorkflowMessage[];
  facts?: JsonRecord;
  preferences?: JsonRecord;
  goals?: string[];
  constraints?: string[];
}

export interface EngineDeps extends WorkflowDeps {
  llm: LlmClient;
  now?: (() => Date) | undefined;
}

export type EngineUserMessageInput = string | WorkflowUserMessage;

export interface WorkflowEngineOptions {
  workflows: readonly WorkflowDefinitionInput[];
  deps: EngineDeps;
  routing?: WorkflowRoutingOptions | undefined;
  render?: WorkflowRenderOptions | undefined;
  maxProgramRounds?: number;
  logger?: (line: string) => void;
}

export interface WorkflowRoutingOptions {
  router?: WorkflowRouter | undefined;
  gate?: RouteGate | undefined;
  candidateProvider?: WorkflowCandidateProvider | undefined;
  gateModel?: string | undefined;
  minGateConfidence?: number | undefined;
  maxWorkflowProfiles?: number | undefined;
  recentMessageLimit?: number | undefined;
}

export type WorkflowRenderMergeDecision = "merge" | "separate";

export interface WorkflowRenderMergeCandidate {
  workflowId: WorkflowId;
  renderName: string;
}

export interface WorkflowRenderMergeStrategyInput {
  session: EngineSession;
  message: string;
  workflows: readonly WorkflowRenderMergeCandidate[];
}

export type WorkflowRenderMergeStrategy = (
  input: WorkflowRenderMergeStrategyInput,
) => MaybePromise<WorkflowRenderMergeDecision>;

export interface WorkflowRenderOptions {
  /**
   * Chooses whether multiple independently rendered LLM workflow responses
   * should be merged into one engine response. Defaults to `merge`;
   * separate outputs are emitted in workflow completion order, and
   * function-based renders stay separate.
   */
  mergeStrategy?: WorkflowRenderMergeStrategy | undefined;
}

export interface EngineTraceEvent {
  workflowId: WorkflowId | "engine";
  phase: string;
  detail?: unknown;
}

export interface EngineInvokeResult {
  messages: WorkflowMessage[];
  events: EngineStreamEvent[];
}

export interface AssistantMessageEvent {
  type: "assistant.message.delta";
  workflowId: WorkflowId;
  workflowIds?: readonly WorkflowId[];
  delta: string;
}

export interface WorkflowStepProgressEvent {
  type: "workflow.step.progress";
  workflowId: WorkflowId;
  node: string;
  stage: string;
  progress: string;
  description?: string;
}

export interface WorkflowStepLifecycleEvent {
  type: "workflow.step.start" | "workflow.step.end";
  workflowId: WorkflowId;
  node: string;
  stage: string;
  stepId: string;
  parentStepId?: string;
  label: string;
  status?: "done" | "error";
  durationMs?: number;
  detail?: unknown;
}

export type WorkflowStepEvent = WorkflowStepProgressEvent | WorkflowStepLifecycleEvent;

export interface EngineTraceStreamEvent {
  type: "engine.trace";
  trace: EngineTraceEvent;
}

export interface EngineTurnDoneEvent {
  type: "engine.turn.done";
}

export type EngineStreamEvent =
  | AssistantMessageEvent
  | WorkflowStepEvent
  | EngineTraceStreamEvent
  | EngineTurnDoneEvent;

export type EngineStreamPayload =
  | { message: WorkflowMessage }
  | { event: EngineStreamEvent };

export interface EngineEventSink {
  emit(payload: EngineStreamPayload): void;
}
