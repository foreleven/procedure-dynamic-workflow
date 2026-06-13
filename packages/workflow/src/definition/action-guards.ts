import { z } from "zod";
import type { RenderCase } from "../actions.js";
import type { ConnectorCatalog } from "../connectors.js";
import {
  functionSchema,
  nonEmptyString,
  parseSchema,
} from "../utils/schema.js";

/**
 * Asserts workflow action helper configuration at the public helper boundary.
 * Input: caller supplied action helper arguments.
 * Output: throws stable definition-time errors before workflow execution.
 * Boundary: this verifies helper contracts only; workflow state values remain schema-owned elsewhere.
 */
export function assertActionFunction(
  value: unknown,
  label: string,
): asserts value is (...args: never[]) => unknown {
  parseSchema(functionSchema(`${label} must be a function`), value);
}

export function assertActionNonEmptyString(value: unknown, label: string): asserts value is string {
  parseSchema(nonEmptyString(label), value);
}

export function assertActionNonEmptyStringArray(value: unknown, label: string): asserts value is string[] {
  parseSchema(nonEmptyStringArraySchema(label), value);
}

export function assertRenderCases<TState extends object, TConnectors extends ConnectorCatalog>(
  cases: unknown,
  label: string,
): asserts cases is Array<RenderCase<TState, TConnectors>> {
  const renderCases = parseSchema(z.array(z.unknown(), { message: `${label} must be an array` }), cases);
  renderCases.forEach((renderCase, index) => assertRenderCase(renderCase, `${label}[${index}]`));
}

export function assertRenderCase<TState extends object, TConnectors extends ConnectorCatalog>(
  renderCase: unknown,
  label: string,
): asserts renderCase is RenderCase<TState, TConnectors> {
  parseSchema(renderCaseSchema(label), renderCase);
}

function renderCaseSchema(label: string) {
  return z.object(
    {
      when: functionSchema(`${label}.when must be a function`).optional(),
      text: renderTextSchema(`${label}.text`),
      data: functionSchema(`${label}.data must be a function`).optional(),
    },
    { message: `${label} must be an object` },
  );
}

function renderTextSchema(label: string) {
  return z.union([
    nonEmptyString(label),
    functionSchema(`${label} must be a function`),
  ]);
}

function nonEmptyStringArraySchema(label: string) {
  const message = `${label} must be a non-empty string array`;
  return z
    .array(z.string(), { message })
    .min(1, message)
    .superRefine((items, context) => {
      if (!items.every((item) => item.trim().length > 0)) {
        context.addIssue({ code: "custom", message });
      }
    });
}
