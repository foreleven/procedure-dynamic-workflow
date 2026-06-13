/**
 * Compares arbitrary runtime values without requiring them to be JSON-serializable.
 * Input: values that may include user-provided runtime objects, BigInt, or circular references.
 * Output: true when values are referentially identical or JSON-native values are structurally equal.
 * Boundary: non-JSON runtime values are treated as changed because context values may be arbitrary objects.
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
