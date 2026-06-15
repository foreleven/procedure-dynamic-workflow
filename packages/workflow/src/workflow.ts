import { z } from "zod";
import type {
  JsonRecord,
  MaybePromise,
  RoutingProfile,
  SessionContext,
  WorkflowId,
} from "./common.js";
import type { PatchPolicy } from "./builders.js";
import type {
  ConnectorCatalog,
  ConnectorRegistry,
} from "./connectors.js";
import type { WorkflowContext } from "./runtime/context.js";
import { PrefetchStore } from "./runtime/prefetch.js";
import type { WorkflowMessage, WorkflowToolMessage } from "./runtime/messages.js";
import { assertWorkflowDefinitionInvariants } from "./definition/workflow-guards.js";

export { WorkflowContextStore } from "./runtime/context.js";
export type { WorkflowContext, WorkflowContextCallOptions } from "./runtime/context.js";
export { ToolMessage } from "./runtime/messages.js";
export type {
  ToolMessageInput,
  WorkflowAssistantMessage,
  WorkflowMessage,
  WorkflowToolMessage,
  WorkflowUserMessage,
} from "./runtime/messages.js";

export type WorkflowRuntimeState<TState extends object> = TState & {
  messages: WorkflowMessage[];
};

export interface WorkflowDeps<TConnectors extends ConnectorCatalog = ConnectorCatalog> {
  connectors: ConnectorRegistry<TConnectors>;
  now?: () => Date;
}

export interface WorkflowRuntimeInput<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  session: SessionContext;
  context: WorkflowContext<TConnectors>;
  state: WorkflowRuntimeState<TState>;
  preState: WorkflowRuntimeState<TState>;
  prefetch: PrefetchStore;
  deps: WorkflowDeps<TConnectors>;
  turn: WorkflowTurn;
  step: WorkflowStepController;
  message?: string;
}

export interface WorkflowTurn {
  stateChangedFields: string[];
  contextChangedKeys: string[];
  prefetchChangedKeys: string[];
  invalidatedStateFields: string[];
}

export type PrefetchResult = Record<string, unknown> | void;

export type PrefetchFunction<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = (
  input: WorkflowRuntimeInput<TState, TConnectors>,
) => MaybePromise<PrefetchResult>;

export type WorkflowStatePatch<TState extends object> = Partial<Omit<TState, "messages">>;

export interface WorkflowPatch<TState extends object> {
  state?: WorkflowStatePatch<TState>;
  messages?: WorkflowToolMessage[];
}

/**
 * Represents one workflow-owned loading step inside a running node.
 * Input: optional completion detail for diagnostics.
 * Output: a step-end trace event; repeated end calls are ignored by the engine.
 */
export interface WorkflowStepHandle {
  readonly id: string;
  readonly label: string;
  end(detail?: unknown): void;
}

/**
 * Starts user-visible sub-steps from workflow node code.
 * Input: short loading label plus optional diagnostic detail.
 * Output: a handle that should be ended after the async work completes.
 */
export interface WorkflowStepController {
  start(label: string, detail?: unknown): WorkflowStepHandle;
}

export type WorkflowFunction<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = (
  input: WorkflowRuntimeInput<TState, TConnectors>,
) => MaybePromise<WorkflowPatch<TState> | void>;

export type WorkflowNodeStage = "beforePatch" | "withPatch" | "afterPatch";

export interface WorkflowNodeBase<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  name: string;
  stage: WorkflowNodeStage;
  progress?: string | undefined;
  description: string;
  when?: (
    input: WorkflowRuntimeInput<TState, TConnectors>,
  ) => MaybePromise<boolean>;
}

export interface WorkflowPrefetchNode<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> extends WorkflowNodeBase<TState, TConnectors> {
  kind: "prefetch";
  run: PrefetchFunction<TState, TConnectors>;
}

export interface WorkflowEffectNode<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> extends WorkflowNodeBase<TState, TConnectors> {
  kind: "effect";
  dependsOn?: readonly string[];
  run: WorkflowFunction<TState, TConnectors>;
}

export type WorkflowNode<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> =
  | WorkflowPrefetchNode<TState, TConnectors>
  | WorkflowEffectNode<TState, TConnectors>;

export interface RenderResponse {
  text: string;
  data?: unknown;
}

export interface RenderPolicy {
  name: string;
  instruction: string;
  progress: string;
}

export type RenderFunction<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> = (
  input: WorkflowRuntimeInput<TState, TConnectors>,
) => MaybePromise<RenderResponse>;

export interface WorkflowDefinition<
  TState extends object = JsonRecord,
  TPatch = unknown,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  id: WorkflowId;
  version: string;
  description: string;
  routing: RoutingProfile;
  stateSchema: z.ZodType<TState>;
  state: TState;
  nodes: Array<WorkflowNode<TState, TConnectors>>;
  patch: PatchPolicy<TPatch>;
  invalidation: Partial<Record<keyof TState & string, Array<keyof TState & string>>>;
  render: RenderPolicy | RenderFunction<TState, TConnectors>;
}

export interface WorkflowInstance<TState extends object = JsonRecord> {
  id: WorkflowId;
  version: string;
  artifact: WorkflowDefinition<TState>;
  context: WorkflowContext;
  state: WorkflowRuntimeState<TState>;
  prefetch: PrefetchStore;
}

/**
 * Defines a direct workflow artifact with early metadata and invariant checks.
 * Input: complete workflow identity, routing, schemas, nodes, invalidation, and render behavior.
 * Output: the same definition with generic state, patch, and connector types preserved.
 * Boundary: trusts TypeScript shape and rejects runtime-only definition invariants.
 */
export function defineWorkflowDefinition<
  TStateSchema extends z.ZodType<object>,
  TPatch,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  definition: WorkflowDefinition<z.infer<TStateSchema>, TPatch, TConnectors> & {
    stateSchema: TStateSchema;
  },
): WorkflowDefinition<z.infer<TStateSchema>, TPatch, TConnectors> {
  assertWorkflowDefinitionInvariants(definition);
  return definition;
}
