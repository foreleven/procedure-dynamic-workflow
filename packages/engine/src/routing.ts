/**
 * Facade for the workflow routing subsystem.
 * Input/output contracts live in the re-exported OOP modules.
 * Boundary: routing selects workflows only; workflow patching still owns business state extraction.
 */
export {
  AllWorkflowCandidateProvider,
  WorkflowCandidateProvider,
} from "./routing/candidate-provider.js";
export {
  FlashLlmRouteGate,
  RouteGate,
} from "./routing/route-gate.js";
export {
  WorkflowRouter,
} from "./routing/router.js";
export type {
  RoutingAction,
  WorkflowRoutingInput,
  WorkflowRoutingResult,
} from "./routing/router.js";
