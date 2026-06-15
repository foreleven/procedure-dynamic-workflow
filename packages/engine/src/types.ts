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
  WorkflowInstance,
  WorkflowMessage,
  WorkflowNodeStage,
  WorkflowRuntimeState,
} from "@pac/workflow";
import type { LlmClient } from "./llm/client.js";
import type { RouteGate } from "./routing/route-gate.js";
import type { WorkflowCandidateProvider } from "./routing/candidate-provider.js";
import type { WorkflowRouter } from "./routing/router.js";

export type RuntimeWorkflow = WorkflowDefinition<JsonRecord, unknown>;
export type RuntimeInstance = WorkflowInstance<JsonRecord>;

export interface WorkflowDefinitionNodeInput {
  kind: "prefetch" | "effect";
  name: string;
  stage: WorkflowNodeStage;
  progress?: string | undefined;
  description: string;
  dependsOn?: readonly string[];
  when?: (input: never) => MaybePromise<boolean>;
  run: (input: never) => MaybePromise<unknown>;
}

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
  facts?: JsonRecord;
  preferences?: JsonRecord;
  goals?: string[];
  constraints?: string[];
}

export interface EngineDeps extends WorkflowDeps {
  llm: LlmClient;
}

export interface WorkflowEngineOptions {
  workflows: readonly WorkflowDefinitionInput[];
  deps: EngineDeps;
  routing?: WorkflowRoutingOptions | undefined;
  maxProgramRounds?: number;
  logger?: (line: string) => void;
  onResponseDelta?: (event: { workflowId: WorkflowId; delta: string }) => void;
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

export interface EngineTraceEvent {
  workflowId: WorkflowId | "engine";
  phase: string;
  detail?: unknown;
}

export interface EngineTurnResult {
  response: RenderResponse;
  responses: Array<{ workflowId: WorkflowId; response: RenderResponse }>;
  session: EngineSession;
  traces: EngineTraceEvent[];
}

export interface TargetSelection {
  instances: RuntimeInstance[];
  ids: Set<WorkflowId>;
}

export type RecentWorkflowMessage = WorkflowMessage;
