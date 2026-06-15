import type { RuntimeWorkflow } from "./types.js";

/**
 * Scores a workflow for local lexical routing on a normalized 0..1 scale.
 * Input: the latest user message and one workflow routing profile.
 * Output: confidence score comparable with RoutingProfile thresholds.
 * Boundary: this is a deterministic pre-router; Patch still owns structured business extraction.
 */
export function scoreWorkflow(message: string, workflow: RuntimeWorkflow): number {
  const normalized = message.toLowerCase();
  let exampleMatches = 0;
  let entityMatches = 0;
  let descriptionMatches = 0;

  for (const example of workflow.routing.examples) {
    if (includesTerm(normalized, example)) exampleMatches += 1;
  }

  for (const entity of workflow.routing.entities) {
    if (includesTerm(normalized, entity)) entityMatches += 1;
  }

  for (const term of workflow.description.toLowerCase().split(/[,\s/，、]+/).filter(Boolean)) {
    if (includesTerm(normalized, term)) descriptionMatches += 1;
  }

  return Math.max(
    scoreExampleMatches(exampleMatches),
    scoreEntityMatches(entityMatches),
    scoreDescriptionMatches(descriptionMatches),
  );
}

export function workflowForLlm(workflow: RuntimeWorkflow) {
  return {
    id: workflow.id,
    version: workflow.version,
    description: workflow.description,
    routing: workflow.routing,
  };
}

function includesTerm(message: string, term: string): boolean {
  const lowered = term.toLowerCase();
  return lowered.length >= 2 && message.includes(lowered);
}

function scoreExampleMatches(matches: number): number {
  if (matches <= 0) return 0;
  return Math.min(1, 0.92 + (matches - 1) * 0.02);
}

function scoreEntityMatches(matches: number): number {
  if (matches <= 0) return 0;
  return Math.min(0.9, 0.62 + matches * 0.08);
}

function scoreDescriptionMatches(matches: number): number {
  if (matches <= 0) return 0;
  return Math.min(0.62, 0.34 + matches * 0.06);
}
