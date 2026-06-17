import {
  AckRequestSchema,
  resolveAckSelection,
  type AckRequest,
  type AckSelection,
} from "../ack.js";
import type { JsonRecord } from "../common.js";
import type {
  ConnectorCatalog,
  ConnectorId,
  ConnectorInput,
  ConnectorOutput,
  ConnectorRegistry,
} from "../connectors.js";
import { sameRuntimeValue } from "./equality.js";

/**
 * Controls workflow-context connector calls without changing connector contracts.
 * Boundary: cache keys are interpreted only by the current WorkflowContextStore instance.
 */
export interface WorkflowContextCallOptions {
  /**
   * Enables caching with the default key: connector id plus JSON.stringify(input).
   */
  cache?: boolean;
  /**
   * Stable key for memoizing in-flight and successful connector calls.
   */
  cacheKey?: unknown;
}

export interface WorkflowContext<TConnectors extends ConnectorCatalog = ConnectorCatalog> {
  readonly revision: number;
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  call<TId extends ConnectorId<TConnectors>>(
    id: TId,
    input: ConnectorInput<TConnectors[TId]>,
    options?: WorkflowContextCallOptions,
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

export interface WorkflowContextStoreCheckpoint {
  readonly values: readonly (readonly [string, unknown])[];
  readonly keyRevisions: readonly (readonly [string, number])[];
  readonly connectorCallCache: readonly {
    readonly connectorId: string;
    readonly cacheKey: unknown;
    readonly promise: Promise<unknown>;
  }[];
  readonly currentRevision: number;
  readonly currentAck: AckRequest | undefined;
}

/**
 * Conversation-scoped runtime context.
 * It is intentionally not schema-validated, cloned, or persisted because workflows may store
 * non-serializable runtime objects such as handles, closures, or memoized service clients here.
 */
export class WorkflowContextStore<TConnectors extends ConnectorCatalog = ConnectorCatalog> implements WorkflowContext<TConnectors> {
  private readonly values = new Map<string, unknown>();
  private readonly keyRevisions = new Map<string, number>();
  private readonly connectorCallCache: ConnectorCallCacheEntry[] = [];
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
    options?: WorkflowContextCallOptions,
  ): Promise<ConnectorOutput<TConnectors[TId]>> {
    const cacheKey = resolveConnectorCallCacheKey(id, input, options);
    if (!cacheKey.enabled) {
      return this.connectors.call(id, input);
    }

    const cached = this.findConnectorCall(id, cacheKey.value);
    if (cached) {
      return cached.promise as Promise<ConnectorOutput<TConnectors[TId]>>;
    }

    const promise = this.connectors.call(id, input);
    this.connectorCallCache.push({ connectorId: id, cacheKey: cacheKey.value, promise });
    void promise.catch(() => {
      this.deleteConnectorCall(id, promise);
    });
    return promise;
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

  /**
   * Captures mutable context internals for engine turn rollback.
   * Input: current in-memory values, revisions, ack, and connector-call cache.
   * Output: a shallow checkpoint that preserves non-serializable runtime object identities.
   * Boundary: intended for runtime transaction control, not persistence or cross-process transport.
   */
  checkpoint(): WorkflowContextStoreCheckpoint {
    return {
      values: [...this.values.entries()],
      keyRevisions: [...this.keyRevisions.entries()],
      connectorCallCache: [...this.connectorCallCache],
      currentRevision: this.currentRevision,
      currentAck: this.currentAck,
    };
  }

  /**
   * Restores a checkpoint created by this store type.
   * Input: checkpoint from `checkpoint()`.
   * Output: this store's mutable in-memory state reset to that checkpoint.
   * Boundary: connector promises are restored by reference because connector work cannot be cloned.
   */
  restore(checkpoint: WorkflowContextStoreCheckpoint): void {
    this.values.clear();
    for (const [key, value] of checkpoint.values) {
      this.values.set(key, value);
    }

    this.keyRevisions.clear();
    for (const [key, revision] of checkpoint.keyRevisions) {
      this.keyRevisions.set(key, revision);
    }

    this.connectorCallCache.length = 0;
    this.connectorCallCache.push(...checkpoint.connectorCallCache);
    this.currentRevision = checkpoint.currentRevision;
    this.currentAck = checkpoint.currentAck;
  }

  private markChanged(key: string): void {
    this.currentRevision += 1;
    this.keyRevisions.set(key, this.currentRevision);
  }

  /**
   * Finds an in-flight or resolved connector call for this workflow context.
   * Input: connector id plus workflow-authored cache key.
   * Output: the stored promise when the id and cache key match.
   * Boundary: connector input is intentionally not compared; callers must include all input dependencies in the key.
   */
  private findConnectorCall(connectorId: string, cacheKey: unknown): ConnectorCallCacheEntry | undefined {
    return this.connectorCallCache.find(
      (entry) => entry.connectorId === connectorId && sameRuntimeValue(entry.cacheKey, cacheKey),
    );
  }

  private deleteConnectorCall(connectorId: string, promise: Promise<unknown>): void {
    const index = this.connectorCallCache.findIndex(
      (entry) => entry.connectorId === connectorId && entry.promise === promise,
    );
    if (index >= 0) {
      this.connectorCallCache.splice(index, 1);
    }
  }
}

interface ConnectorCallCacheEntry {
  readonly connectorId: string;
  readonly cacheKey: unknown;
  readonly promise: Promise<unknown>;
}

type ConnectorCallCacheKey =
  | {
      readonly enabled: false;
    }
  | {
      readonly enabled: true;
      readonly value: unknown;
    };

/**
 * Resolves the cache key for one connector call.
 * Input: connector id, raw connector input, and call options.
 * Output: disabled cache, explicit cacheKey, or default id+JSON input key.
 * Boundary: default cache requires JSON.stringify(input) because connector inputs are the stable boundary.
 */
function resolveConnectorCallCacheKey(
  connectorId: string,
  input: unknown,
  options: WorkflowContextCallOptions | undefined,
): ConnectorCallCacheKey {
  if (options?.cacheKey !== undefined && options.cacheKey !== null) {
    return { enabled: true, value: options.cacheKey };
  }

  if (options?.cache !== true) {
    return { enabled: false };
  }

  return { enabled: true, value: [connectorId, stringifyConnectorCallInput(connectorId, input)] };
}

function stringifyConnectorCallInput(connectorId: string, input: unknown): string {
  try {
    const serialized = JSON.stringify(input);
    if (serialized !== undefined) return serialized;
  } catch (error) {
    throw new Error(`Workflow context call cache=true requires JSON-serializable input for ${connectorId}`, {
      cause: error,
    });
  }

  throw new Error(`Workflow context call cache=true requires JSON-serializable input for ${connectorId}`);
}
