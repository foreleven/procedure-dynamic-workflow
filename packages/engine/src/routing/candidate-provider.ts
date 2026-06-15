import type { WorkflowId } from "@pac/workflow";
import type { RuntimeWorkflow } from "../types.js";
import { workflowRoutingProfile, type WorkflowRoutingProfile } from "./workflow-profile.js";

export interface WorkflowCandidateInput {
  message: string;
  workflows: readonly RuntimeWorkflow[];
  activeWorkflowIds: readonly WorkflowId[];
  lastMatchedWorkflowIds: readonly WorkflowId[];
}

export abstract class WorkflowCandidateProvider {
  abstract getCandidates(input: WorkflowCandidateInput): Promise<WorkflowRoutingProfile[]>;
}

export interface AllWorkflowCandidateProviderOptions {
  maxWorkflowProfiles?: number | undefined;
  maxExamplesPerWorkflow?: number | undefined;
  maxEntitiesPerWorkflow?: number | undefined;
}

/**
 * Returns compact profiles for all registered workflows while the catalog is small.
 * Input: the registered workflow list for this engine.
 * Output: bounded route-gate candidate profiles.
 * Boundary: this deliberately does no lexical filtering; future RAG replaces this provider.
 */
export class AllWorkflowCandidateProvider extends WorkflowCandidateProvider {
  constructor(private readonly options: AllWorkflowCandidateProviderOptions = {}) {
    super();
  }

  async getCandidates(input: WorkflowCandidateInput): Promise<WorkflowRoutingProfile[]> {
    const maxProfiles = this.options.maxWorkflowProfiles ?? 64;
    if (input.workflows.length > maxProfiles) {
      throw new Error(
        `Workflow routing candidate count ${input.workflows.length} exceeds maxWorkflowProfiles ${maxProfiles}`,
      );
    }

    return input.workflows.map((workflow) => workflowRoutingProfile(workflow, this.options));
  }
}
