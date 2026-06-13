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
import { sameRuntimeValue } from "./equality.js";
import { PrefetchStore } from "./prefetch.js";

const RESERVED_STATE_FIELDS = new Set(["messages"]);
const ROUTING_THRESHOLD_FIELDS = ["localAccept", "localUncertain", "globalAccept"] as const;

export interface WorkflowUserMessage {
  role: "user";
  content: string;
}

export interface WorkflowAssistantMessage {
  role: "assistant";
  content: string;
}

export interface WorkflowToolMessage {
  role: "tool";
  name: string;
  call?: unknown;
  result: unknown;
}

export type WorkflowMessage = WorkflowUserMessage | WorkflowAssistantMessage | WorkflowToolMessage;

export type WorkflowRuntimeState<TState extends object> = TState & {
  messages: WorkflowMessage[];
};

export interface WorkflowDeps<TConnectors extends ConnectorCatalog = ConnectorCatalog> {
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
    if (sameRuntimeValue(this.values.get(key), value)) return;
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
    if (!sameRuntimeValue(this.currentAck, parsed)) {
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
  state: WorkflowRuntimeState<TState>;
  prefetch: PrefetchStore;
}

/**
 * Defines a direct workflow artifact with early metadata and shape validation.
 * Input: complete workflow identity, routing, schemas, nodes, invalidation, and render behavior.
 * Output: the same definition with generic state, patch, and connector types preserved.
 * Boundary: validates definition-time structure only; workflow callbacks run inside the engine.
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
  validateWorkflowDefinition(definition);
  return definition;
}

/**
 * Validates a direct workflow artifact and preserves its generic type information.
 * Input: complete workflow metadata, schemas, nodes, invalidation, and render behavior.
 * Output: the same workflow definition when the artifact is well-formed.
 * Boundary: this does not run workflow callbacks; the engine still owns scheduling and execution.
 */
function validateWorkflowDefinition(value: unknown): asserts value is WorkflowDefinition<object> {
  if (!isPlainRecord(value)) {
    throw new Error("Workflow definition must be an object");
  }
  if (!isNonEmptyString(value.id)) {
    throw new Error("Workflow definition id must be a non-empty string");
  }

  const label = `Workflow ${value.id}`;
  if (!isNonEmptyString(value.version)) {
    throw new Error(`${label} version must be a non-empty string`);
  }
  if (!isNonEmptyString(value.description)) {
    throw new Error(`${label} description must be a non-empty string`);
  }
  validateRoutingProfile(value.routing, `${label} routing`);
  if (!hasParser(value.stateSchema)) {
    throw new Error(`${label} stateSchema must provide parse(input)`);
  }
  validateDefaultState(value.id, value.stateSchema, value.state);
  validatePatchPolicy(value.patch, `${label} patch`);
  validateInvalidation(value.invalidation, `${label} invalidation`);
  validateWorkflowNodes(value.nodes, `${label} nodes`);
  validateRender(value.render, `${label} render`);
}

function validateRoutingProfile(value: unknown, label: string): void {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  validateNonEmptyStringArray(value.examples, `${label}.examples`);
  validateNonEmptyStringArray(value.entities, `${label}.entities`);
  validateNonEmptyStringArray(value.neighbors, `${label}.neighbors`);
  if (!isPlainRecord(value.thresholds)) {
    throw new Error(`${label}.thresholds must be an object`);
  }

  const supportedThresholds = new Set<string>(ROUTING_THRESHOLD_FIELDS);
  for (const key of Object.keys(value.thresholds)) {
    if (!supportedThresholds.has(key)) {
      throw new Error(`${label}.thresholds.${key} is not supported`);
    }
  }

  for (const field of ROUTING_THRESHOLD_FIELDS) {
    const threshold = value.thresholds[field];
    if (!isRoutingThreshold(threshold)) {
      throw new Error(`${label}.thresholds.${field} must be a finite number between 0 and 1`);
    }
  }
}

function validateDefaultState(
  workflowId: WorkflowId,
  stateSchema: { parse: (input: unknown) => unknown },
  state: unknown,
): void {
  if (!isPlainRecord(state)) {
    throw new Error(`Workflow ${workflowId} default state must be an object`);
  }
  for (const field of RESERVED_STATE_FIELDS) {
    if (Object.hasOwn(state, field)) {
      throw new Error(`Workflow ${workflowId} default state must not define reserved ${field} field`);
    }
  }

  let parsed: unknown;
  try {
    parsed = stateSchema.parse(state);
  } catch (error) {
    throw new Error(`Workflow ${workflowId} default state does not satisfy stateSchema: ${errorMessage(error)}`);
  }

  if (!isPlainRecord(parsed)) {
    throw new Error(`Workflow ${workflowId} default state must parse to an object`);
  }
  for (const field of RESERVED_STATE_FIELDS) {
    if (Object.hasOwn(parsed, field)) {
      throw new Error(`Workflow ${workflowId} parsed default state must not define reserved ${field} field`);
    }
  }
}

function validatePatchPolicy(value: unknown, label: string): void {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (!hasParser(value.schema)) {
    throw new Error(`${label}.schema must provide parse(input)`);
  }
  if (!isNonEmptyString(value.instruction)) {
    throw new Error(`${label}.instruction must be a non-empty string`);
  }
  validateOptionalNonEmptyString(value.model, `${label}.model`);
  validateOptionalNonEmptyString(value.progress, `${label}.progress`);
}

function validateInvalidation(value: unknown, label: string): void {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const [field, dependents] of Object.entries(value)) {
    if (!isNonEmptyString(field)) {
      throw new Error(`${label} field must be a non-empty string`);
    }
    if (!Array.isArray(dependents) || dependents.length === 0 || !dependents.every(isNonEmptyString)) {
      throw new Error(`${label}.${field} must be an array of non-empty strings`);
    }
  }
}

function validateWorkflowNodes(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (value.length === 0) {
    throw new Error(`${label} must contain at least one node`);
  }

  const names = new Set<string>();
  value.forEach((node, index) => {
    validateWorkflowNode(node, `${label}[${index}]`);
    if (names.has(node.name)) {
      throw new Error(`${label} contains duplicate node name: ${node.name}`);
    }
    names.add(node.name);
  });
}

function validateWorkflowNode(value: unknown, label: string): asserts value is WorkflowNode<object> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (value.kind !== "prefetch" && value.kind !== "effect") {
    throw new Error(`${label}.kind must be prefetch or effect`);
  }
  if (!isNonEmptyString(value.name)) {
    throw new Error(`${label}.name must be a non-empty string`);
  }
  if (!isWorkflowNodeStage(value.stage)) {
    throw new Error(`${label}.${value.name} stage must be beforePatch, withPatch, or afterPatch`);
  }
  if (!isNonEmptyString(value.progress)) {
    throw new Error(`${label}.${value.name} progress must be a non-empty string`);
  }
  if (!isNonEmptyString(value.description)) {
    throw new Error(`${label}.${value.name} description must be a non-empty string`);
  }
  if (value.when !== undefined && typeof value.when !== "function") {
    throw new Error(`${label}.${value.name} when must be a function`);
  }
  if (typeof value.run !== "function") {
    throw new Error(`${label}.${value.name} run must be a function`);
  }
}

function validateRender(value: unknown, label: string): void {
  if (typeof value === "function") return;
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a function or render policy`);
  }
  if (!isNonEmptyString(value.name)) {
    throw new Error(`${label}.name must be a non-empty string`);
  }
  if (!isNonEmptyString(value.instruction)) {
    throw new Error(`${label}.instruction must be a non-empty string`);
  }
  if (!isNonEmptyString(value.progress)) {
    throw new Error(`${label}.progress must be a non-empty string`);
  }
}

function validateNonEmptyStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}

function validateOptionalNonEmptyString(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function hasParser(value: unknown): value is { parse: (input: unknown) => unknown } {
  return isRecord(value) && typeof value.parse === "function";
}

function isWorkflowNodeStage(value: unknown): value is WorkflowNodeStage {
  return value === "beforePatch" || value === "withPatch" || value === "afterPatch";
}

function isRoutingThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
