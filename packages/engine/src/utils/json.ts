/**
 * Stringifies diagnostic data without requiring workflow-owned values to be JSON-serializable.
 * Input: arbitrary runtime/log value plus optional indentation.
 * Output: a JSON-like string safe for logs, CLI diagnostics, and LLM debug text.
 * Boundary: this is for diagnostics only; it must not be used to persist or validate business state.
 */
export function safeJsonStringify(value: unknown, space?: number): string {
  const result = JSON.stringify(normalizeForJson(value, new WeakSet()), undefined, space);
  return result ?? "undefined";
}

/**
 * Compares runtime values without crashing on non-serializable values.
 * Input: existing and incoming runtime values.
 * Output: true for referential identity or structurally equal JSON-native values.
 * Boundary: non-JSON runtime values are treated as changed because engine state should remain JSON-shaped.
 */
export function sameRuntimeValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;

  if (!hasJsonComparableShape(left) || !hasJsonComparableShape(right)) {
    return false;
  }

  return sameJsonValue(left, right);
}

function hasJsonComparableShape(value: unknown, stack = new WeakSet<object>()): boolean {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return hasJsonComparableObjectShape(value, stack);
    default:
      return false;
  }
}

function hasJsonComparableObjectShape(value: object, stack: WeakSet<object>): boolean {
  if (stack.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;

  if (Array.isArray(value)) {
    stack.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !hasJsonComparableShape(value[index], stack)) return false;
      }
      return true;
    } finally {
      stack.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  stack.add(value);
  try {
    return Object.values(value).every((item) => hasJsonComparableShape(item, stack));
  } finally {
    stack.delete(value);
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;

  switch (typeof left) {
    case "string":
    case "boolean":
      return left === right;
    case "number":
      return typeof right === "number" && Number.isFinite(left) && Number.isFinite(right) && left === right;
    case "object":
      return sameJsonObject(left, right as object);
    default:
      return false;
  }
}

function sameJsonObject(left: object, right: object): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.hasOwn(left, index) || !Object.hasOwn(right, index)) return false;
      if (!sameJsonValue(left[index], right[index])) return false;
    }
    return true;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  const rightRecord = right as Record<string, unknown>;
  const leftRecord = left as Record<string, unknown>;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key)) return false;
    if (!sameJsonValue(leftRecord[key], rightRecord[key])) return false;
  }

  return true;
}

function normalizeForJson(value: unknown, stack: WeakSet<object>): unknown {
  switch (typeof value) {
    case "bigint":
    case "symbol":
      return value.toString();
    case "function":
      return `[Function ${value.name || "anonymous"}]`;
    case "object":
      return normalizeObjectForJson(value, stack);
    default:
      return value;
  }
}

function normalizeObjectForJson(value: object | null, stack: WeakSet<object>): unknown {
  if (value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? value.toString() : value.toISOString();
  }
  if (stack.has(value)) return "[Circular]";

  stack.add(value);
  try {
    if (value instanceof Map) {
      return Object.fromEntries(
        [...value.entries()].map(([key, item]) => [mapKeyForJson(key, stack), normalizeForJson(item, stack)]),
      );
    }
    if (value instanceof Set) {
      return [...value.values()].map((item) => normalizeForJson(item, stack));
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalizeForJson(item, stack));
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeForJson(item, stack)]),
    );
  } finally {
    stack.delete(value);
  }
}

function mapKeyForJson(key: unknown, stack: WeakSet<object>): string {
  if (typeof key === "string") return key;
  if (typeof key === "number" || typeof key === "boolean" || typeof key === "bigint" || typeof key === "symbol") {
    return key.toString();
  }
  if (key && typeof key === "object" && stack.has(key)) return "[Circular]";
  return JSON.stringify(normalizeForJson(key, stack)) ?? "undefined";
}
