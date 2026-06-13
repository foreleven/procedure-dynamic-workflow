import { z } from "zod";
import type { MaybePromise } from "../common.js";
import {
  isNonEmptyString,
  nonEmptyString,
  parseSchema,
} from "../utils/schema.js";

export class PrefetchStore {
  readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    parsePrefetchKey(key);
    return this.values.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    parsePrefetchKey(key);
    if (value !== undefined) {
      this.values.set(key, value);
    }
  }

  merge(values: Record<string, unknown> | undefined | null): void {
    if (values === undefined || values === null) return;
    const parsedValues = parseRecordWithKeys(values, "PrefetchStore.merge values", "PrefetchStore key");

    for (const [key, value] of Object.entries(parsedValues)) {
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
  const parsedTasks = parseRecordWithKeys(tasks, "prefetch tasks", "prefetch task key");

  const entries = await Promise.all(
    Object.entries(parsedTasks).map(async ([key, task]) => {
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

function parsePrefetchKey(key: unknown): string {
  return parseSchema(nonEmptyString("PrefetchStore key"), key);
}

function parseRecordWithKeys(value: unknown, label: string, keyLabel: string): Record<string, unknown> {
  return parseSchema(recordWithNonEmptyKeysSchema(label, keyLabel), value);
}

function recordWithNonEmptyKeysSchema(label: string, keyLabel: string) {
  return plainRecordSchema(label).superRefine((record, context) => {
    for (const key of Object.keys(record)) {
      if (!isNonEmptyString(key)) {
        context.addIssue({
          code: "custom",
          message: `${keyLabel} must be a non-empty string`,
          path: [key],
        });
      }
    }
  });
}

function plainRecordSchema(label: string) {
  return z
    .unknown()
    .superRefine((value, context) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        context.addIssue({ code: "custom", message: `${label} must be an object` });
        return;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        context.addIssue({ code: "custom", message: `${label} must be a plain object` });
      }
    })
    .transform((value) => value as Record<string, unknown>);
}
