import type { RuntimeWorkflow } from "./types.js";

export function scoreWorkflow(message: string, workflow: RuntimeWorkflow): number {
  const normalized = message.toLowerCase();
  let score = 0;

  for (const example of workflow.routing.examples) {
    if (includesTerm(normalized, example)) score += 5;
  }

  for (const entity of workflow.routing.entities) {
    if (includesTerm(normalized, entity)) score += 1;
  }

  for (const term of workflow.description.toLowerCase().split(/[,\s/，、]+/).filter(Boolean)) {
    if (includesTerm(normalized, term)) score += 2;
  }

  return score;
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
