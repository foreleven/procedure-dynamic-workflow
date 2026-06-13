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
