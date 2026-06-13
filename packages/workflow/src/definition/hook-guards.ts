import { z } from "zod";
import type { ConnectorCatalog } from "../connectors.js";
import type { WorkflowNodeOptions } from "../hooks.js";
import {
  functionSchema,
  nonEmptyString,
  parseSchema,
} from "../utils/schema.js";

/**
 * Asserts hook-style workflow node options at registration time.
 * Input: caller supplied node name and optional hook metadata.
 * Output: throws stable definition-time errors before workflow execution.
 * Boundary: hook callbacks remain typed by the public DSL; this only checks runtime-visible metadata.
 */
export function assertHookNodeInvariants<
  TState extends object,
  TConnectors extends ConnectorCatalog,
>(
  name: string,
  options: WorkflowNodeOptions<TState, TConnectors> | undefined,
): void {
  parseSchema(nonEmptyString("Workflow node name"), name);
  if (options === undefined) return;
  parseSchema(hookNodeOptionsSchema(), options);
}

function hookNodeOptionsSchema() {
  return z.object({
    stage: z.enum(["beforePatch", "withPatch", "afterPatch"], {
      message: "Workflow node option stage must be beforePatch, withPatch, or afterPatch",
    }).optional(),
    progress: nonEmptyString("Workflow node option progress").optional(),
    description: nonEmptyString("Workflow node option description").optional(),
    when: functionSchema("Workflow node option when must be a function").optional(),
  });
}
