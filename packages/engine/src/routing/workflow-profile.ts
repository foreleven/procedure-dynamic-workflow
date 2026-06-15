import type { WorkflowId } from "@pac/workflow";
import type { RuntimeWorkflow } from "../types.js";

export interface WorkflowRoutingProfile {
  id: WorkflowId;
  version: string;
  description: string;
  examples: string[];
  entities: string[];
  neighbors: WorkflowId[];
  isFallback?: boolean | undefined;
}

export interface WorkflowProfileOptions {
  maxExamplesPerWorkflow?: number | undefined;
  maxEntitiesPerWorkflow?: number | undefined;
}

/**
 * Projects a workflow artifact into the compact metadata visible to route gates.
 * Input: a runtime workflow definition plus profile size limits.
 * Output: stable routing metadata without schemas, node prompts, tool facts, or procedure text.
 * Boundary: this is diagnostic/routing context only; Patch still owns business extraction.
 */
export function workflowRoutingProfile(
  workflow: RuntimeWorkflow,
  options: WorkflowProfileOptions = {},
): WorkflowRoutingProfile {
  const maxExamples = options.maxExamplesPerWorkflow ?? 3;
  const maxEntities = options.maxEntitiesPerWorkflow ?? 12;
  return {
    id: workflow.id,
    version: workflow.version,
    description: workflow.description,
    examples: workflow.routing.examples.slice(0, maxExamples),
    entities: workflow.routing.entities.slice(0, maxEntities),
    neighbors: [...workflow.routing.neighbors],
  };
}
