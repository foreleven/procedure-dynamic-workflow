import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { WorkflowEngine, type LlmClient, type LlmStructuredRequest } from "@pac/engine";
import { createConnectorRegistry, defineConnectorTool, z } from "@pac/workflow";
import type { MaintenanceState } from "../scenarios/maintenance/maintenance_booking.workflow.js";
import maintenanceBookingWorkflow from "../scenarios/maintenance/maintenance_booking.workflow.js";
import connectors, {
  confirmMaintenanceBookingConnector,
  getAvailableSlots,
  getRecentDealerConnector,
  maintenanceConnectorCatalog,
  maintenanceConnectorTools,
} from "../scenarios/maintenance/connectors.js";
import {
  mockCustomers,
  mockDealers,
  mockRecentDealerByUser,
  mockSlotTemplatesByDealer,
  mockVehiclesByUser,
} from "../scenarios/maintenance/mockData.js";

const WorkflowYamlSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  routing: z.object({
    examples: z.array(z.string().min(1)).min(1),
    entities: z.array(z.string().min(1)).min(1),
    neighbors: z.array(z.string().min(1)),
  }),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      userId: z.string().min(1),
      turns: z.array(
        z.object({
          message: z.string().min(1),
          expect: z.object({
            responseSatisfies: z.string().min(1),
          }),
        }),
      ).min(1),
    }),
  ).min(1),
});

const workflowYaml = WorkflowYamlSchema.parse(
  YAML.parse(readFileSync("scenarios/maintenance/workflow.yaml", "utf8")),
);

verifyWorkflowMetadata();
verifyCases();
verifyConnectors();
verifyMockData();
await verifyRuntimeHappyPath();
await verifyRuntimeCancellation();
await verifyRuntimeMultiVehicleSelection();
await verifyRuntimeTimeChangeInvalidation();
await verifyRuntimeDraftFollowupDoesNotCommit();
await verifyRuntimeExplicitPreviousDealerSelection();
await verifyRuntimeNoAvailabilityFallback();
await verifyRuntimePrefetchConnectorFailureIsolation();
await verifyRuntimeCommandConnectorFailure();
await verifyRuntimeNoVehicleFallback();

console.log(
  `ok maintenance scenario: ${workflowYaml.cases.length} cases, ${maintenanceConnectorTools.length} connectors, 10 runtime paths`,
);

/**
 * Verifies that workflow.yaml remains aligned with the executable workflow artifact.
 * Input: parsed YAML metadata and imported workflow definition.
 * Output: throws on mismatch.
 * Boundary: this does not execute user turns or call LLMs.
 */
function verifyWorkflowMetadata(): void {
  assertEqual(maintenanceBookingWorkflow.id, workflowYaml.id, "workflow id");
  assertEqual(maintenanceBookingWorkflow.version, workflowYaml.version, "workflow version");
  assertEqual(maintenanceBookingWorkflow.description, workflowYaml.description, "workflow description");
  assertArrayEqual(maintenanceBookingWorkflow.routing.examples, workflowYaml.routing.examples, "routing examples");
  assertArrayEqual(maintenanceBookingWorkflow.routing.entities, workflowYaml.routing.entities, "routing entities");
  assertArrayEqual(maintenanceBookingWorkflow.routing.neighbors, workflowYaml.routing.neighbors, "routing neighbors");
}

/**
 * Verifies that scenario cases are uniquely identified and point at known mock users.
 * Input: parsed YAML cases and mock customer data.
 * Output: throws on missing users or duplicate case ids.
 * Boundary: semantic response expectations remain covered by the manual LLM scenario runner.
 */
function verifyCases(): void {
  const caseIds = new Set<string>();

  for (const testCase of workflowYaml.cases) {
    if (caseIds.has(testCase.id)) {
      throw new Error(`Duplicate maintenance scenario case id: ${testCase.id}`);
    }
    caseIds.add(testCase.id);

    if (!mockCustomers[testCase.userId]) {
      throw new Error(`Maintenance scenario case ${testCase.id} references unknown user: ${testCase.userId}`);
    }
  }
}

/**
 * Verifies that every connector call referenced by the workflow has a registered implementation.
 * Input: workflow source, connector catalog, connector tools, and runtime registry.
 * Output: throws on missing or inconsistent connector ids.
 * Boundary: connector business behavior is tested elsewhere; this checks wiring only.
 */
function verifyConnectors(): void {
  const catalogIds = Object.keys(maintenanceConnectorCatalog).sort();
  const toolIds = maintenanceConnectorTools.map((tool) => tool.id).sort();
  assertArrayEqual(toolIds, catalogIds, "connector tools and catalog ids");

  for (const connectorId of connectorCallsFromWorkflowSource()) {
    if (!connectors.has(connectorId)) {
      throw new Error(`Workflow calls unregistered connector: ${connectorId}`);
    }
  }
}

/**
 * Verifies that mock fixture references are internally consistent.
 * Input: mock customers, vehicles, dealers, recent-dealer mapping, and slot templates.
 * Output: throws on dangling references or vehicles with no candidate dealer.
 * Boundary: date/time slot generation is intentionally left to connector unit coverage.
 */
function verifyMockData(): void {
  for (const userId of Object.keys(mockVehiclesByUser)) {
    if (!mockCustomers[userId]) {
      throw new Error(`Mock vehicles reference unknown user: ${userId}`);
    }

    for (const vehicle of mockVehiclesByUser[userId] ?? []) {
      const candidates = Object.values(mockDealers).filter((dealer) => dealer.brands.includes(vehicle.make));
      if (candidates.length === 0) {
        throw new Error(`Vehicle ${vehicle.id} has no compatible dealer for make ${vehicle.make}`);
      }
    }
  }

  for (const [userId, dealerId] of Object.entries(mockRecentDealerByUser)) {
    if (!mockCustomers[userId]) {
      throw new Error(`Recent dealer mapping references unknown user: ${userId}`);
    }
    if (!mockDealers[dealerId]) {
      throw new Error(`Recent dealer mapping references unknown dealer: ${dealerId}`);
    }
  }

  for (const dealerId of Object.keys(mockSlotTemplatesByDealer)) {
    if (!mockDealers[dealerId]) {
      throw new Error(`Slot templates reference unknown dealer: ${dealerId}`);
    }
  }
}

/**
 * Verifies the executable maintenance workflow can complete a booking with deterministic patches.
 * Input: imported workflow, mock connectors, and a fake LLM that returns schema-valid state patches.
 * Output: throws when the runtime fails to create a draft or commit the final booking.
 * Boundary: this does not validate natural-language extraction or response quality; LLM semantic checks stay manual.
 */
async function verifyRuntimeHappyPath(): Promise<void> {
  const vehicle = requireValue(mockVehiclesByUser.user_feng?.[0], "user_feng vehicle");
  const dealer = requireValue(mockDealers.dealer_hoboken_bmw, "dealer_hoboken_bmw");
  const preferredDate = afternoonDate("明天下午", "2026-06-14");
  const slot = requireValue(
    (await getAvailableSlots({ dealer, dateRange: preferredDate }))[0],
    "first Hoboken BMW afternoon slot",
  );
  const { engine, session } = createRuntime("user_feng", "maintenance_runtime_happy_path", [
    { preferredDate },
    { dealer },
    { slot },
    { status: "draft_confirmed" },
  ]);

  await engine.onMessage("预约保养，明天下午", session);
  let state = requireInstanceState(engine, session);
  assertEqual(state.vehicle?.id, vehicle.id, "runtime selected vehicle");
  assertEqual(state.dealer?.id, undefined, "runtime dealer before explicit selection");
  assertEqual(state.bookingDraft, null, "runtime draft before slot selection");

  await engine.onMessage("选 Hoboken BMW Service", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.dealer?.id, dealer.id, "runtime selected dealer");
  assertEqual(state.slot, null, "runtime slot before explicit selection");

  await engine.onMessage("选 14:30", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.slot?.id, slot.id, "runtime selected slot");
  assertEqual(state.status, "draft_ready", "runtime draft status");
  assertEqual(state.bookingDraft?.dealer.id, dealer.id, "runtime draft dealer");
  assertEqual(state.booking, null, "runtime booking before confirmation");

  await engine.onMessage("确认", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.status, "booked", "runtime booked status");
  assertEqual(state.bookingDraft, null, "runtime clears committed draft");
  assertEqual(state.booking?.status, "confirmed", "runtime confirmed booking");
  assertEqual(state.booking?.dealer.id, dealer.id, "runtime booking dealer");
}

/**
 * Verifies cancellation stops the deterministic runtime path without creating drafts or bookings.
 * Input: mock single-vehicle user and fake LLM patches.
 * Output: throws when cancellation state is not preserved.
 * Boundary: this checks runtime state, not cancellation wording.
 */
async function verifyRuntimeCancellation(): Promise<void> {
  const { engine, session } = createRuntime("user_feng", "maintenance_runtime_cancellation", [
    {},
    { status: "cancelled" },
  ]);

  await engine.onMessage("预约保养", session);
  await engine.onMessage("先不约了，取消", session);
  const state = requireInstanceState(engine, session);
  assertEqual(state.status, "cancelled", "runtime cancellation status");
  assertEqual(state.bookingDraft, null, "runtime cancellation draft");
  assertEqual(state.booking, null, "runtime cancellation booking");
}

/**
 * Verifies a multi-vehicle user must explicitly select vehicle and dealer before draft creation.
 * Input: mock multi-vehicle user and fake LLM patches.
 * Output: throws when runtime guesses vehicle/dealer or creates a draft too early.
 * Boundary: this does not validate response copy for listing options.
 */
async function verifyRuntimeMultiVehicleSelection(): Promise<void> {
  const tesla = requireValue(
    mockVehiclesByUser.user_alex?.find((vehicle) => vehicle.id === "veh_tesla_model_y"),
    "user_alex Tesla Model Y",
  );
  const dealer = requireValue(mockDealers.dealer_newport_ev, "dealer_newport_ev");
  const preferredDate = afternoonDate("明天下午", "2026-06-14");
  const { engine, session } = createRuntime("user_alex", "maintenance_runtime_multi_vehicle", [
    {},
    { vehicle: tesla, preferredDate },
    { dealer },
  ]);

  await engine.onMessage("预约保养", session);
  let state = requireInstanceState(engine, session);
  assertEqual(state.vehicle, null, "runtime multi-vehicle initial vehicle");
  assertEqual(state.dealer, null, "runtime multi-vehicle initial dealer");
  assertEqual(state.bookingDraft, null, "runtime multi-vehicle initial draft");

  await engine.onMessage("选 Tesla Model Y，明天下午", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.vehicle?.id, tesla.id, "runtime multi-vehicle selected vehicle");
  assertEqual(state.dealer, null, "runtime multi-vehicle dealer before explicit selection");
  assertEqual(state.slot, null, "runtime multi-vehicle slot before explicit selection");

  await engine.onMessage("选 Newport EV Service Studio", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.dealer?.id, dealer.id, "runtime multi-vehicle selected dealer");
  assertEqual(state.slot, null, "runtime multi-vehicle slot after dealer selection");
  assertEqual(state.bookingDraft, null, "runtime multi-vehicle draft after dealer selection");
}

/**
 * Verifies changing preferred time after draft creation invalidates stale slot and draft data.
 * Input: mock single-vehicle user, fake LLM patches, and generated slots for two date windows.
 * Output: throws when stale draft state survives the time change.
 * Boundary: this checks invalidation behavior, not natural-language acknowledgement.
 */
async function verifyRuntimeTimeChangeInvalidation(): Promise<void> {
  const dealer = requireValue(mockDealers.dealer_hoboken_bmw, "dealer_hoboken_bmw");
  const originalDate = afternoonDate("下周三下午", "2026-06-17");
  const changedDate = afternoonDate("明天下午", "2026-06-14");
  const originalSlot = requireValue(
    (await getAvailableSlots({ dealer, dateRange: originalDate }))[0],
    "first Hoboken BMW original afternoon slot",
  );
  const { engine, session } = createRuntime("user_feng", "maintenance_runtime_time_change", [
    { preferredDate: originalDate },
    { dealer },
    { slot: originalSlot },
    { preferredDate: changedDate, status: "collecting" },
  ]);

  await engine.onMessage("预约保养，下周三下午", session);
  await engine.onMessage("选 Hoboken BMW Service", session);
  await engine.onMessage("选第一个时段", session);
  let state = requireInstanceState(engine, session);
  assertEqual(state.status, "draft_ready", "runtime time-change setup draft status");
  assertEqual(state.bookingDraft?.slot.id, originalSlot.id, "runtime time-change setup draft slot");

  await engine.onMessage("改成明天下午", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.status, "collecting", "runtime time-change status");
  assertEqual(state.preferredDate?.start, changedDate.start, "runtime time-change preferred date");
  assertEqual(state.slot, null, "runtime time-change invalidated slot");
  assertEqual(state.bookingDraft, null, "runtime time-change invalidated draft");
  assertEqual(state.booking, null, "runtime time-change booking");
}

/**
 * Verifies service-detail follow-up questions after draft creation do not commit the booking.
 * Input: mock single-vehicle user, fake LLM patches, and a generated draft.
 * Output: throws when a follow-up question clears or commits the draft.
 * Boundary: service-detail wording remains a manual LLM scenario concern.
 */
async function verifyRuntimeDraftFollowupDoesNotCommit(): Promise<void> {
  const dealer = requireValue(mockDealers.dealer_hoboken_bmw, "dealer_hoboken_bmw");
  const preferredDate = afternoonDate("明天下午", "2026-06-14");
  const slot = requireValue(
    (await getAvailableSlots({ dealer, dateRange: preferredDate }))[0],
    "first Hoboken BMW follow-up slot",
  );
  const { engine, session } = createRuntime("user_feng", "maintenance_runtime_draft_followup", [
    { preferredDate },
    { dealer },
    { slot },
    {},
  ]);

  await engine.onMessage("预约保养，明天下午", session);
  await engine.onMessage("选 Hoboken BMW Service", session);
  await engine.onMessage("选第一个时段", session);
  let state = requireInstanceState(engine, session);
  assertEqual(state.status, "draft_ready", "runtime follow-up setup draft status");
  assertEqual(state.bookingDraft?.slot.id, slot.id, "runtime follow-up setup draft slot");

  await engine.onMessage("这次保养要做什么项目？", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.status, "draft_ready", "runtime follow-up keeps draft status");
  assertEqual(state.bookingDraft?.slot.id, slot.id, "runtime follow-up keeps draft");
  assertEqual(state.booking, null, "runtime follow-up booking");
}

/**
 * Verifies explicit previous-dealer selection uses the recent dealer but still waits for a slot choice.
 * Input: mock user with a recent dealer and fake LLM patches.
 * Output: throws when runtime creates a draft before the concrete slot selection.
 * Boundary: recognizing "previous dealer" from text remains a manual LLM scenario concern.
 */
async function verifyRuntimeExplicitPreviousDealerSelection(): Promise<void> {
  const vehicle = requireValue(mockVehiclesByUser.user_wang?.[0], "user_wang vehicle");
  const dealer = requireValue(mockDealers.dealer_brooklyn_mini, "dealer_brooklyn_mini");
  const preferredDate = afternoonDate("明天下午", "2026-06-14");
  const slot = requireValue(
    (await getAvailableSlots({ dealer, dateRange: preferredDate }))[0],
    "first Brooklyn MINI afternoon slot",
  );
  const { engine, session } = createRuntime("user_wang", "maintenance_runtime_previous_dealer", [
    { dealer, preferredDate },
    { slot },
  ]);

  await engine.onMessage("MINI Cooper S，还是上次那家，明天下午", session);
  let state = requireInstanceState(engine, session);
  assertEqual(state.vehicle?.id, vehicle.id, "runtime previous dealer selected vehicle");
  assertEqual(state.dealer?.id, dealer.id, "runtime previous dealer selected dealer");
  assertEqual(state.slot, null, "runtime previous dealer waits for slot");
  assertEqual(state.bookingDraft, null, "runtime previous dealer draft before slot");

  await engine.onMessage("选第一个时段", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.slot?.id, slot.id, "runtime previous dealer selected slot");
  assertEqual(state.status, "draft_ready", "runtime previous dealer draft status");
  assertEqual(state.bookingDraft?.dealer.id, dealer.id, "runtime previous dealer draft dealer");
  assertEqual(state.booking, null, "runtime previous dealer booking");
}

/**
 * Verifies the slot connector fallback path still allows draft creation when no template matches the requested window.
 * Input: mock single-vehicle user, an evening window without configured slot templates, and fake LLM patches.
 * Output: throws when fallback slot generation or draft creation fails.
 * Boundary: this checks deterministic fallback behavior, not whether fallback slots are appropriate for production.
 */
async function verifyRuntimeNoAvailabilityFallback(): Promise<void> {
  const dealer = requireValue(mockDealers.dealer_hoboken_bmw, "dealer_hoboken_bmw");
  const preferredDate = eveningDate("明天晚上", "2026-06-14");
  const fallbackSlot = requireValue(
    (await getAvailableSlots({ dealer, dateRange: preferredDate }))[0],
    "Hoboken BMW evening fallback slot",
  );
  const { engine, session } = createRuntime("user_feng", "maintenance_runtime_no_availability_fallback", [
    { preferredDate },
    { dealer },
    { slot: fallbackSlot },
  ]);

  await engine.onMessage("预约保养，明天晚上", session);
  await engine.onMessage("选 Hoboken BMW Service", session);
  await engine.onMessage("选 fallback 时段", session);
  const state = requireInstanceState(engine, session);

  assertEqual(fallbackSlot.id, "dealer_hoboken_bmw_fallback_20260614", "runtime fallback slot id");
  assertEqual(fallbackSlot.advisorName, "Service Advisor", "runtime fallback slot advisor");
  assertEqual(state.slot?.id, fallbackSlot.id, "runtime fallback selected slot");
  assertEqual(state.status, "draft_ready", "runtime fallback draft status");
  assertEqual(state.bookingDraft?.slot.id, fallbackSlot.id, "runtime fallback draft slot");
  assertEqual(state.booking, null, "runtime fallback booking");
}

/**
 * Verifies an optional prefetch connector failure does not prevent the workflow from progressing.
 * Input: connector registry where recent-dealer lookup rejects and fake LLM patches for dealer/slot selection.
 * Output: throws when the runtime fails to keep customer/vehicle data and create a draft.
 * Boundary: command connector failures are intentionally not swallowed and are not covered here.
 */
async function verifyRuntimePrefetchConnectorFailureIsolation(): Promise<void> {
  const dealer = requireValue(mockDealers.dealer_hoboken_bmw, "dealer_hoboken_bmw");
  const preferredDate = afternoonDate("明天下午", "2026-06-14");
  const slot = requireValue(
    (await getAvailableSlots({ dealer, dateRange: preferredDate }))[0],
    "Hoboken BMW slot with failing recent dealer connector",
  );
  const failingRecentDealerConnectors = createConnectorRegistry(
    [
      ...maintenanceConnectorTools.filter((tool) => tool.id !== getRecentDealerConnector.id),
      defineConnectorTool(getRecentDealerConnector, async () => {
        throw new Error("recent dealer fixture failure");
      }),
    ],
    maintenanceConnectorCatalog,
  );
  const { engine, session } = createRuntime("user_feng", "maintenance_runtime_prefetch_failure", [
    { preferredDate },
    { dealer },
    { slot },
  ], failingRecentDealerConnectors);

  await engine.onMessage("预约保养，明天下午", session);
  let state = requireInstanceState(engine, session);
  const instance = requireInstance(engine, session);
  assertEqual(state.vehicle?.id, "veh_bmw_x3", "runtime prefetch failure selected vehicle");
  assertEqual(instance.context.get("recentDealer"), undefined, "runtime prefetch failure recent dealer context");
  assertEqual(Array.isArray(instance.context.get("vehicles")), true, "runtime prefetch failure vehicles context");

  await engine.onMessage("选 Hoboken BMW Service", session);
  await engine.onMessage("选第一个时段", session);
  state = requireInstanceState(engine, session);
  assertEqual(state.status, "draft_ready", "runtime prefetch failure draft status");
  assertEqual(state.bookingDraft?.slot.id, slot.id, "runtime prefetch failure draft slot");
}

/**
 * Verifies irreversible command connector failures are not swallowed and do not create bookings.
 * Input: connector registry where confirmBooking rejects and fake LLM patches through draft confirmation.
 * Output: throws when command failure is swallowed or writes a committed booking.
 * Boundary: retry and recovery UX remains outside this deterministic state check.
 */
async function verifyRuntimeCommandConnectorFailure(): Promise<void> {
  const dealer = requireValue(mockDealers.dealer_hoboken_bmw, "dealer_hoboken_bmw");
  const preferredDate = afternoonDate("明天下午", "2026-06-14");
  const slot = requireValue(
    (await getAvailableSlots({ dealer, dateRange: preferredDate }))[0],
    "Hoboken BMW slot with failing confirm connector",
  );
  const failingConfirmConnectors = createConnectorRegistry(
    [
      ...maintenanceConnectorTools.filter((tool) => tool.id !== confirmMaintenanceBookingConnector.id),
      defineConnectorTool(confirmMaintenanceBookingConnector, async () => {
        throw new Error("confirm booking fixture failure");
      }),
    ],
    maintenanceConnectorCatalog,
  );
  const { engine, session } = createRuntime("user_feng", "maintenance_runtime_command_failure", [
    { preferredDate },
    { dealer },
    { slot },
    { status: "draft_confirmed" },
  ], failingConfirmConnectors);

  await engine.onMessage("预约保养，明天下午", session);
  await engine.onMessage("选 Hoboken BMW Service", session);
  await engine.onMessage("选第一个时段", session);
  await expectRejects(
    () => engine.onMessage("确认", session),
    "confirm booking fixture failure",
    "runtime command failure",
  );
  const state = requireInstanceState(engine, session);
  assertEqual(state.status, "draft_confirmed", "runtime command failure status");
  assertEqual(state.bookingDraft?.slot.id, slot.id, "runtime command failure keeps draft");
  assertEqual(state.booking, null, "runtime command failure booking");
}

/**
 * Verifies a user with no vehicles does not get an inferred vehicle, dealer, slot, or draft.
 * Input: unknown mock user id with empty vehicle list and a fake LLM patch.
 * Output: throws when the runtime guesses missing business entities.
 * Boundary: user-facing copy for no vehicles remains a manual render scenario concern.
 */
async function verifyRuntimeNoVehicleFallback(): Promise<void> {
  const { engine, session } = createRuntime("user_no_vehicles", "maintenance_runtime_no_vehicle", [{}]);

  await engine.onMessage("预约保养", session);
  const state = requireInstanceState(engine, session);
  const instance = requireInstance(engine, session);
  const vehicles = instance.context.get("vehicles");

  assertEqual(Array.isArray(vehicles), true, "runtime no-vehicle context vehicles array");
  assertEqual((vehicles as unknown[]).length, 0, "runtime no-vehicle context vehicles length");
  assertEqual(state.vehicle, null, "runtime no-vehicle vehicle");
  assertEqual(state.dealer, null, "runtime no-vehicle dealer");
  assertEqual(state.slot, null, "runtime no-vehicle slot");
  assertEqual(state.bookingDraft, null, "runtime no-vehicle draft");
  assertEqual(state.booking, null, "runtime no-vehicle booking");
}

/**
 * Creates a deterministic engine/session pair for runtime scenario verification.
 * Input: user id, session id, and ordered fake LLM state patches.
 * Output: engine and session with the maintenance workflow already active.
 * Boundary: the fake clock keeps relative-date workflow behavior deterministic.
 */
function createRuntime(
  userId: string,
  sessionId: string,
  patches: Array<Record<string, unknown>>,
  connectorRegistry = connectors,
): {
  engine: WorkflowEngine;
  session: ReturnType<WorkflowEngine["createSession"]>;
} {
  const engine = new WorkflowEngine({
    workflows: [maintenanceBookingWorkflow],
    deps: {
      connectors: connectorRegistry,
      llm: scriptedMaintenanceLlm(patches),
      now: () => new Date("2026-06-13T10:00:00+08:00"),
    },
  });
  const session = engine.createSession({
    sessionId,
    userId,
    activeWorkflowIds: [maintenanceBookingWorkflow.id],
  });

  return { engine, session };
}

/**
 * Builds the normalized afternoon date window used by deterministic scenario patches.
 * Input: display label and local YYYY-MM-DD date.
 * Output: DateRange-compatible object in Asia/Shanghai local offset.
 * Boundary: natural-language date parsing remains covered by manual LLM scenarios.
 */
function afternoonDate(label: string, date: string): { label: string; start: string; end: string } {
  return {
    label,
    start: `${date}T14:30:00+08:00`,
    end: `${date}T16:30:00+08:00`,
  };
}

/**
 * Builds the normalized evening date window used to exercise unavailable-slot fallback behavior.
 * Input: display label and local YYYY-MM-DD date.
 * Output: DateRange-compatible object outside the maintenance fixture's configured slots.
 * Boundary: natural-language date parsing remains covered by manual LLM scenarios.
 */
function eveningDate(label: string, date: string): { label: string; start: string; end: string } {
  return {
    label,
    start: `${date}T20:00:00+08:00`,
    end: `${date}T21:00:00+08:00`,
  };
}

/**
 * Builds a fake LLM that returns queued schema-valid patches and fixed render text.
 * Input: ordered state patches, one per runtime user turn.
 * Output: LLM client suitable for deterministic engine verification.
 * Boundary: this deliberately bypasses natural-language extraction and response generation.
 */
function scriptedMaintenanceLlm(patches: Array<Record<string, unknown>>): LlmClient {
  const remainingPatches = [...patches];
  return {
    async text(): Promise<string> {
      return "ok";
    },

    async structured<TSchema extends z.ZodType>(
      request: LlmStructuredRequest<TSchema>,
    ): Promise<z.infer<TSchema>> {
      const statePatch = remainingPatches.shift();
      if (!statePatch) {
        throw new Error(`No scripted maintenance patch left for ${request.name}`);
      }

      return request.schema.parse({ statePatch });
    },
  };
}

/**
 * Returns the maintenance state after a runtime turn.
 * Input: engine and session from the deterministic runtime check.
 * Output: parsed workflow state.
 * Boundary: this helper is for verification only and does not mutate runtime state.
 */
function requireInstanceState(engine: WorkflowEngine, session: ReturnType<WorkflowEngine["createSession"]>): MaintenanceState {
  return requireInstance(engine, session).state;
}

/**
 * Returns the maintenance runtime instance after a deterministic verification turn.
 * Input: engine and session from the deterministic runtime check.
 * Output: workflow instance for state/context assertions.
 * Boundary: this helper is for verification only and does not mutate runtime state.
 */
function requireInstance(engine: WorkflowEngine, session: ReturnType<WorkflowEngine["createSession"]>) {
  const instance = engine.getInstance<MaintenanceState>(session, maintenanceBookingWorkflow.id);
  if (!instance) {
    throw new Error("Missing maintenance runtime instance");
  }

  return instance;
}

/**
 * Reads a required mock fixture value with a labeled failure.
 * Input: possibly missing fixture value and a human-readable label.
 * Output: the fixture value.
 * Boundary: this is verification-only and should not be used as runtime fallback logic.
 */
function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing fixture value: ${label}`);
  }

  return value;
}

/**
 * Verifies an async operation rejects with the expected message.
 * Input: thunk returning the async operation, expected message snippet, and assertion label.
 * Output: throws when the operation succeeds or rejects for a different reason.
 * Boundary: this avoids bringing a test framework into the standalone verifier script.
 */
async function expectRejects(operation: () => Promise<unknown>, expectedMessage: string, label: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(`${label} rejection mismatch: ${JSON.stringify(message)} does not include ${expectedMessage}`);
    }
    return;
  }

  throw new Error(`${label} unexpectedly resolved`);
}

/**
 * Extracts connector ids from workflow source calls such as context.call("connector.id", input).
 * Input: workflow TypeScript source.
 * Output: sorted unique connector ids.
 * Boundary: this is a static wiring check, not a TypeScript parser.
 */
function connectorCallsFromWorkflowSource(): string[] {
  const source = readFileSync(resolve("scenarios/maintenance/maintenance_booking.workflow.ts"), "utf8");
  return [...new Set([...source.matchAll(/\.call\("([^"]+)"/g)].map((match) => match[1] ?? ""))]
    .filter(Boolean)
    .sort();
}

/**
 * Compares scalar values with a labeled error message.
 * Input: actual value, expected value, and label.
 * Output: throws on mismatch.
 * Boundary: intended for human-readable verification failures only.
 */
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

/**
 * Compares arrays after preserving order from the source artifacts.
 * Input: actual array, expected array, and label.
 * Output: throws on mismatch.
 * Boundary: use only where order is meaningful or stable in source files.
 */
function assertArrayEqual(actual: readonly string[], expected: readonly string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}
