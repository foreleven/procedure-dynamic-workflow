import type { EngineEventSink, EngineStreamPayload } from "../types.js";

interface PendingNext {
  resolve: (value: IteratorResult<EngineStreamPayload>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Bridges engine-internal event emission to external async iteration.
 * Input: runtime code calls emit methods while a turn is executing.
 * Output: consumers read ordered payloads through AsyncIterable.
 * Boundary: this queue is per-turn, not shared across sessions or concurrent engine calls.
 */
export class EngineEventStream implements AsyncIterable<EngineStreamPayload>, AsyncIterator<EngineStreamPayload>, EngineEventSink {
  private readonly queue: EngineStreamPayload[] = [];
  private readonly pending: PendingNext[] = [];
  private closed = false;
  private returned = false;
  private failure: unknown;

  emit(payload: EngineStreamPayload): void {
    if (this.returned || this.closed || this.failure !== undefined) return;

    const next = this.pending.shift();
    if (next) {
      next.resolve({ done: false, value: payload });
      return;
    }

    this.queue.push(payload);
  }

  complete(): void {
    if (this.closed || this.failure !== undefined) return;

    this.closed = true;
    this.flushDone();
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) return;

    this.failure = error;
    for (const pending of this.pending.splice(0)) {
      pending.reject(error);
    }
  }

  next(): Promise<IteratorResult<EngineStreamPayload>> {
    if (this.returned) return Promise.resolve({ done: true, value: undefined });
    const queued = this.queue.shift();
    if (queued) return Promise.resolve({ done: false, value: queued });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ done: true, value: undefined });

    return new Promise<IteratorResult<EngineStreamPayload>>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  return(): Promise<IteratorResult<EngineStreamPayload>> {
    this.returned = true;
    this.queue.length = 0;
    this.flushDone();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineStreamPayload> {
    return this;
  }

  private flushDone(): void {
    if (this.queue.length > 0) return;
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }
}
