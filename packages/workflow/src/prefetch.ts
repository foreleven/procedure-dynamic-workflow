import type { MaybePromise } from "./common.js";

export class PrefetchStore {
  readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    if (value !== undefined) {
      this.values.set(key, value);
    }
  }

  merge(values: Record<string, unknown> | undefined | null): void {
    if (!values) return;

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
