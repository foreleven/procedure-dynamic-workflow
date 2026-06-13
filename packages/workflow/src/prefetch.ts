import type { MaybePromise } from "./common.js";

export class PrefetchStore {
  readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    assertNonEmptyString(key, "PrefetchStore key");
    return this.values.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    assertNonEmptyString(key, "PrefetchStore key");
    if (value !== undefined) {
      this.values.set(key, value);
    }
  }

  merge(values: Record<string, unknown> | undefined | null): void {
    if (!values) return;
    assertPlainRecord(values, "PrefetchStore.merge values");

    for (const [key, value] of Object.entries(values)) {
      this.set(key, value);
    }
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.values.entries());
  }
}

export async function settlePrefetch<TTasks extends Record<string, MaybePromise<unknown>>>(
  tasks: TTasks,
): Promise<Partial<{ [K in keyof TTasks]: Awaited<TTasks[K]> }>> {
  assertPlainRecord(tasks, "prefetch tasks");
  assertNonEmptyObjectKeys(tasks, "prefetch task key");

  const entries = await Promise.all(
    Object.entries(tasks).map(async ([key, task]) => {
      try {
        return [key, await Promise.resolve(task)] as const;
      } catch {
        return [key, undefined] as const;
      }
    }),
  );

  const values: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    if (value !== undefined) {
      values[key] = value;
    }
  }

  return values as Partial<{ [K in keyof TTasks]: Awaited<TTasks[K]> }>;
}

function assertNonEmptyObjectKeys(value: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(value)) {
    assertNonEmptyString(key, label);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
}
