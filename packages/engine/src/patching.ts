import type { JsonRecord, MessagePatch, SessionPatch } from "@pac/workflow";
import type { EngineSession } from "./types.js";

export function normalizeMessagePatch(value: unknown): MessagePatch {
  if (!isRecord(value)) return {};

  return {
    sessionPatch: normalizeSessionPatch(value.sessionPatch),
    statePatch: normalizeRecordPatch(value.statePatch),
  };
}

export function applySessionPatch(session: EngineSession, patch: SessionPatch | undefined): void {
  if (!patch) return;

  Object.assign(session.facts, patch.facts ?? {});
  Object.assign(session.preferences, patch.preferences ?? {});
  session.goals = unique([...session.goals, ...(patch.goals ?? [])]);
  session.constraints = unique([...session.constraints, ...(patch.constraints ?? [])]);
}

export function applyObjectPatch(target: JsonRecord, patch: object): string[] {
  const dirtyFields: string[] = [];

  for (const [field, value] of Object.entries(patch)) {
    if (!sameValue(target[field], value)) {
      target[field] = value;
      dirtyFields.push(field);
    }
  }

  return dirtyFields;
}

export function cloneDefault<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSessionPatch(value: unknown): SessionPatch | undefined {
  if (!isRecord(value)) return undefined;

  const patch: SessionPatch = {};

  if (isRecord(value.facts)) {
    patch.facts = value.facts;
  }

  if (isRecord(value.preferences)) {
    patch.preferences = value.preferences;
  }

  if (isStringArray(value.goals)) {
    patch.goals = value.goals;
  }

  if (isStringArray(value.constraints)) {
    patch.constraints = value.constraints;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function normalizeRecordPatch(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;

  const patch: JsonRecord = {};

  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue !== null && fieldValue !== undefined) {
      patch[key] = fieldValue;
    }
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
