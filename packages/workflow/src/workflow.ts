import { z } from "zod";
import {
  AckRequestSchema,
  resolveAckSelection,
  type AckRequest,
  type AckSelection,
} from "./ack.js";
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
  ConnectorId,
  ConnectorInput,
  ConnectorOutput,
  ConnectorRegistry,
} from "./connectors.js";
import type { LlmClient } from "./llm.js";
import { PrefetchStore } from "./prefetch.js";

export interface WorkflowDeps<TConnectors extends ConnectorCatalog = ConnectorCatalog> {
  llm: LlmClient;
  connectors: ConnectorRegistry<TConnectors>;
  now?: () => Date;
}

export interface WorkflowContext<TConnectors extends ConnectorCatalog = ConnectorCatalog> {
  readonly revision: number;
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  call<TId extends ConnectorId<TConnectors>>(
    id: TId,
    input: ConnectorInput<TConnectors[TId]>,
  ): Promise<ConnectorOutput<TConnectors[TId]>>;
  ack(request: AckRequest): AckRequest;
  getAck(): AckRequest | undefined;
  clearAck(id?: string): boolean;
  resolveAck(message: string): AckSelection | undefined;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  keys(): IterableIterator<string>;
  entries(): IterableIterator<[string, unknown]>;
  changedKeysSince(revision: number): string[];
  toJSON(): JsonRecord;
}

/**
 * Conversation-scoped runtime context.
 * It is intentionally not schema-validated, cloned, or persisted because workflows may store
 * non-serializable runtime objects such as handles, closures, or memoized service clients here.
 */
export class WorkflowContextStore<TConnectors extends ConnectorCatalog = ConnectorCatalog> implements WorkflowContext<TConnectors> {
  private readonly values = new Map<string, unknown>();
  private readonly keyRevisions = new Map<string, number>();
  private currentRevision = 0;
  private currentAck: AckRequest | undefined;

  constructor(private readonly connectors: ConnectorRegistry<TConnectors>) {}

  get revision(): number {
    return this.currentRevision;
  }

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    if (Object.is(this.values.get(key), value)) return;
    this.values.set(key, value);
    this.markChanged(key);
  }

  call<TId extends ConnectorId<TConnectors>>(
    id: TId,
    input: ConnectorInput<TConnectors[TId]>,
  ): Promise<ConnectorOutput<TConnectors[TId]>> {
    return this.connectors.call(id, input);
  }

  /**
   * Stores the current confirmation request for this workflow turn.
   * Input: prompt plus selectable options.
   * Output: parsed AckRequest.
   * Boundary: ack does not mutate business state; workflows map selected options to state.
   */
  ack(request: AckRequest): AckRequest {
    const parsed = AckRequestSchema.parse(request);
    if (!sameValue(this.currentAck, parsed)) {
      this.currentAck = parsed;
      this.markChanged("__ack");
    }
    return parsed;
  }

  getAck(): AckRequest | undefined {
    return this.currentAck;
  }

  clearAck(id?: string): boolean {
    if (!this.currentAck || (id && this.currentAck.id !== id)) return false;
    this.currentAck = undefined;
    this.markChanged("__ack");
    return true;
  }

  resolveAck(message: string): AckSelection | undefined {
    return this.currentAck ? resolveAckSelection(this.currentAck, message) : undefined;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  delete(key: string): boolean {
    const deleted = this.values.delete(key);
    if (deleted) {
      this.markChanged(key);
    }
    return deleted;
  }

  clear(): void {
    for (const key of this.values.keys()) {
      this.values.delete(key);
      this.markChanged(key);
    }
  }

  keys(): IterableIterator<string> {
    return this.values.keys();
  }

  entries(): IterableIterator<[string, unknown]> {
    return this.values.entries();
  }

  changedKeysSince(revision: number): string[] {
    return [...this.keyRevisions.entries()]
      .filter(([, keyRevision]) => keyRevision > revision)
      .map(([key]) => key);
  }

  toJSON(): JsonRecord {
    const values = Object.fromEntries(this.values.entries());
    if (this.currentAck) {
      values.__ack = this.currentAck;
    }
    return values;
  }

  private markChanged(key: string): void {
    this.currentRevision += 1;
    this.keyRevisions.set(key, this.currentRevision);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface WorkflowRuntimeInput<
  TState extends object,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
> {
  session: SessionContext;
  context: WorkflowContext<TConnectors>;
  state: TState;
  preState: TState;
  prefetch: PrefetchStore;
  deps: WorkflowDeps<TConnectors>;
  turn: WorkflowTurn;
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

export interface WorkflowPatch<TState extends object> {
  state?: Partial<TState>;
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
  progress: string;
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
  state: TState;
  prefetch: PrefetchStore;
}

export function defineWorkflowDefinition<
  TStateSchema extends z.ZodType<object>,
  TPatch,
  TConnectors extends ConnectorCatalog = ConnectorCatalog,
>(
  definition: WorkflowDefinition<z.infer<TStateSchema>, TPatch, TConnectors> & {
    stateSchema: TStateSchema;
  },
): WorkflowDefinition<z.infer<TStateSchema>, TPatch, TConnectors> {
  return definition;
}
