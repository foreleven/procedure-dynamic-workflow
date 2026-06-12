import type {
  JsonRecord,
  RenderResponse,
  SessionContext,
  WorkflowDefinition,
  WorkflowDeps,
  WorkflowId,
  WorkflowInstance,
} from "@pac/workflow";

export type RuntimeWorkflow = WorkflowDefinition<JsonRecord, unknown>;
export type RuntimeInstance = WorkflowInstance<JsonRecord>;

export interface WorkflowDefinitionInput {
  id: string;
  version: string;
  description: string;
  routing: unknown;
  stateSchema: unknown;
  state: unknown;
  nodes: unknown;
  patch: unknown;
  invalidation: unknown;
  render: unknown;
}

export interface EngineSession extends SessionContext {
  workflowInstances: Map<WorkflowId, RuntimeInstance>;
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

export interface WorkflowEngineOptions {
  workflows: readonly WorkflowDefinitionInput[];
  deps: WorkflowDeps;
  maxProgramRounds?: number;
  logger?: (line: string) => void;
}

export interface EngineTraceEvent {
  workflowId: WorkflowId;
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
