import { z } from "zod";

export const RouteGateDecisionSchema = z.object({
  action: z.enum(["continue", "switch", "parallel", "clarify", "none"]),
  targetWorkflowIds: z.array(z.string()),
  suspendedWorkflowIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type RawRouteGateDecision = z.infer<typeof RouteGateDecisionSchema>;
