import {
  loadWorkflowMetadata,
  type WorkflowContext,
  type WorkflowToolMessage,
  workflow,
  z,
} from "@pac/workflow";
import type { MaintenanceConnectorCatalog } from "./connectors.js";

const VehicleSchema = z.object({
  id: z.string(), label: z.string(), make: z.string(), model: z.string(), year: z.number(),
  trim: z.string(), vinLast6: z.string(), plateNumber: z.string(), mileage: z.number(),
  powertrain: z.enum(["gasoline", "hybrid", "electric"]), nextRecommendedServiceMileage: z.number(),
});

const DealerSchema = z.object({
  id: z.string(), name: z.string(), city: z.string(), address: z.string(), phone: z.string(),
  brands: z.array(z.string()), distanceKm: z.number(),
  serviceLevel: z.enum(["brand_certified", "independent_specialist", "ev_specialist"]),
  openingHours: z.string(),
});

const DateRangeSchema = z.object({ label: z.string(), start: z.string(), end: z.string() });

const SlotSchema = z.object({
  id: z.string(), label: z.string(), startsAt: z.string(), endsAt: z.string(),
  dealerId: z.string(), advisorName: z.string(), bayType: z.string(),
});

const CustomerSchema = z.object({
  id: z.string(), name: z.string(), city: z.string(), tier: z.enum(["standard", "vip"]),
  phone: z.string(), email: z.string(), preferredLanguage: z.string(), homeZipCode: z.string(),
});

const BookingDraftSchema = z.object({
  id: z.string(), vehicle: VehicleSchema, dealer: DealerSchema, slot: SlotSchema,
  notes: z.array(z.string()),
});

const BookingSchema = z.object({
  id: z.string(), confirmationCode: z.string(), status: z.enum(["confirmed", "cancelled"]),
  time: z.string(), dealerName: z.string(),
  vehicle: VehicleSchema, dealer: DealerSchema, slot: SlotSchema,
  notes: z.array(z.string()),
});

const MaintenanceStatusSchema = z.enum([
  "collecting",
  "draft_ready",
  "draft_confirmed",
  "booked",
  "cancelled",
]);

const MaintenanceStateSchema = z.object({
  status: MaintenanceStatusSchema,
  vehicle: VehicleSchema.nullable(),
  dealer: DealerSchema.nullable(),
  preferredDate: DateRangeSchema.nullable(),
  slot: SlotSchema.nullable(),
  bookingDraft: BookingDraftSchema.nullable(),
  booking: BookingSchema.nullable(),
});

export type MaintenanceState = z.infer<typeof MaintenanceStateSchema>;

type Customer = z.infer<typeof CustomerSchema>;
type DateRange = z.infer<typeof DateRangeSchema>;
type Dealer = z.infer<typeof DealerSchema>;
type Vehicle = z.infer<typeof VehicleSchema>;
type MaintenanceContext = WorkflowContext<MaintenanceConnectorCatalog>;

interface MaintenanceFacts {
  customer: Customer;
  vehicles: Vehicle[];
  recentDealer: Dealer | null;
}

const maintenanceInitialState = MaintenanceStateSchema.parse({
  status: "collecting",
  vehicle: null,
  dealer: null,
  preferredDate: null,
  slot: null,
  bookingDraft: null,
  booking: null,
});

const maintenanceInvalidation = {
  vehicle: ["dealer", "slot", "bookingDraft"],
  dealer: ["slot", "bookingDraft"],
  preferredDate: ["slot", "bookingDraft"],
  slot: ["bookingDraft"],
} satisfies Partial<Record<keyof MaintenanceState & string, Array<keyof MaintenanceState & string>>>;

const metadata = loadWorkflowMetadata(import.meta.url);


/**
 * Input Message -> Patch + prefetch -> effects -> state changed -> Render: llm output
 */

// Create a workflow with state management.
const { patch, prefetch, derive, command, render } = workflow<
  MaintenanceState,
  MaintenanceConnectorCatalog
>({
  ...metadata,
  stateSchema: MaintenanceStateSchema,
  state: maintenanceInitialState,
});

// Patch steps only update state according to the instruction and user's latest message; they do not call connectors or generate final responses.
patch({
  progress: "正在理解您的预约需求",
  state: {
    status: MaintenanceStatusSchema,
    vehicle: VehicleSchema,
    dealer: DealerSchema,
    preferredDate: DateRangeSchema,
    slot: SlotSchema,
  },
  invalidates: maintenanceInvalidation,
  instruction: `
Extract only these maintenance booking state fields: status, vehicle, dealer, preferredDate, and slot.

Selection extraction:
- If the user says "1", "第一个", "就这个", or similar, map it to the option type requested by the immediately preceding assistant question: vehicle, dealer, arrival slot, or draft confirmation.
- When the user selects a vehicle, dealer, or arrival slot, set the matching full object.
- When the user explicitly confirms a displayed booking draft, set status to draft_confirmed.

Dealer extraction:
- Do not set dealer just because recentDealer exists, it is closest, it supports the vehicle, or it is first in candidates.
- For a generic first message like "预约保养" or "帮我预约保养", leave dealer null.
- Set dealer only when the user explicitly names a dealer, asks for the previous/same/recent dealer, or answers a dealer-choice prompt.

Slot and date extraction:
- Do not set slot just because only one slot is available.
- Set slot only when the user explicitly names a time/slot or answers an arrival-slot prompt.
- Extract preferredDate when the user gives a real appointment date/time expression. Use the current date/time in Asia/Shanghai. Preserve the user's phrase as label, and write +08:00 local ISO start/end, never Z or UTC. For vague day parts use 上午 09:30-11:30, 中午 12:00-13:30, 下午 14:30-16:30, 晚上 18:30-20:30.

Status extraction:
- Set status to cancelled only when the user explicitly cancels or stops this booking flow.
- Set status to collecting when the user changes vehicle, dealer, preferredDate, or slot.
- Do not set draft_confirmed for follow-up questions about dealer, time, vehicle, or draft details.

Never invent vehicles, dealers, slots, drafts, bookings, ids, prices, or availability. Only use facts already available in the conversation.
`,
});

// Prefetch steps call connectors and write results to context. They will be executed in parallel with `patch` steps on each turn.
prefetch("customerProfile", {
  progress: "正在读取您的车辆和常用门店信息",
  description: "读取当前客户、名下车辆和最近服务门店；结果写入 context，运行时会把 prefetch 结果追加为 tool message。",
  when: () => true,
  cacheKey: (_state, _context, { session }) => session.userId,
  run: (_state, context, { session }) => ({
    customer: context.call("connectors.maintenance.getCustomer", { userId: session.userId }),
    vehicles: context.call("connectors.maintenance.getUserVehicles", { userId: session.userId }),
    recentDealer: context.call("connectors.maintenance.getRecentDealer", { userId: session.userId }),
  }),
});

// The derive and command steps can call connectors and update state. Returned messages are appended to the runtime message log.
// All derive and command steps are executed in parallel, so they should not have dependencies or conflicts with each other.
derive("selectOnlyVehicle", {
  progress: "正在确认默认车辆",
  description: "客户名下只有一辆车时直接使用该车辆；多车或只有历史推断时仍由 render 引导用户确认。",
  when: (state, context) => !state.vehicle && (maintenanceFacts(context).vehicles?.length ?? 0) === 1,
  run: (state, context) => {
    const [vehicle] = maintenanceFacts(context).vehicles ?? [];
    if (!vehicle) return {};
    return {
      status: state.status === "cancelled" ? state.status : "collecting",
      vehicle,
      messages: [{
        role: "tool",
        name: "selectOnlyVehicle",
        call: { reason: "single_vehicle" },
        result: { vehicle },
      } satisfies WorkflowToolMessage],
    };
  },
});

derive("dealerCandidates", {
  progress: "正在查找可服务该车辆的门店",
  description: "车辆确定或变化后查询支持该品牌/车型的候选门店，并把结果作为 tool message 写入 messages；候选项不进入长期业务 state。",
  when: (state, _context, { preState }) =>
    Boolean(
      state.vehicle &&
      (state.vehicle.id !== preState.vehicle?.id || !preState.vehicle) &&
      _context.get("dealerCandidates:vehicleId") !== state.vehicle.id
    ),
  run: async (state, context) => {
    if (!state.vehicle) return {};
    const dealerCandidates = await context.call("connectors.maintenance.getDealerCandidates", {
      vehicle: state.vehicle,
    });
    context.set("dealerCandidates:vehicleId", state.vehicle.id);

    return {
      messages: [{
        role: "tool",
        name: "connectors.maintenance.getDealerCandidates",
        call: { vehicleId: state.vehicle.id },
        result: dealerCandidates,
      } satisfies WorkflowToolMessage],
    };
  },
});

derive("appointmentAvailability", {
  progress: "正在查询可预约时间",
  description: "门店或期望时间确定/变化后查询真实可用时段，并把候选时段作为 tool message 写入 messages，等待用户选择具体到店时间。",
  when: (state, _context, { preState }) =>
    Boolean(
      state.dealer &&
      state.preferredDate &&
      (
        state.dealer.id !== preState.dealer?.id ||
        state.preferredDate.start !== preState.preferredDate?.start ||
        state.preferredDate.end !== preState.preferredDate?.end ||
        !preState.dealer ||
        !preState.preferredDate
      ) &&
      _context.get("appointmentAvailability:cacheKey") !== availabilityCacheKey(state.dealer, state.preferredDate)
    ),
  run: async (state, context) => {
    if (!state.dealer || !state.preferredDate) return {};
    const cacheKey = availabilityCacheKey(state.dealer, state.preferredDate);
    const availableSlots = await context.call("connectors.maintenance.getAvailableSlots", {
      dealer: state.dealer,
      dateRange: state.preferredDate,
    });
    context.set("appointmentAvailability:cacheKey", cacheKey);

    return {
      messages: [{
        role: "tool",
        name: "connectors.maintenance.getAvailableSlots",
        call: {
          dealerId: state.dealer.id,
          start: state.preferredDate.start,
          end: state.preferredDate.end,
        },
        result: availableSlots,
      } satisfies WorkflowToolMessage],
    };
  },
});

derive("prepareBookingDraft", {
  progress: "正在准备预约草稿",
  description: "车辆、门店、期望时间和用户确认的具体时段齐备后创建待确认草稿；草稿不是正式预约，服务项目由其他 procedure 处理。",
  when: (state) =>
    state.status !== "cancelled" &&
    !selectionMatchesBooking(state) &&
    Boolean(state.vehicle && state.dealer && state.preferredDate && state.slot && !state.bookingDraft),
  run: async (state, context) => {
    if (!state.vehicle || !state.dealer || !state.slot) return {};

    const bookingDraft = await context.call("connectors.maintenance.createBookingDraft", {
      vehicle: state.vehicle,
      dealer: state.dealer,
      slot: state.slot,
    });

    return {
      bookingDraft,
      status: "draft_ready",
      messages: [{
        role: "tool",
        name: "connectors.maintenance.createBookingDraft",
        call: {
          vehicleId: state.vehicle.id,
          dealerId: state.dealer.id,
          slotId: state.slot.id,
        },
        result: bookingDraft,
      } satisfies WorkflowToolMessage],
    };
  },
});

command("commitBooking", {
  progress: "正在提交预约",
  description: "只有用户明确确认草稿后才调用正式确认接口；这是不可逆的外部提交动作。",
  when: (state) =>
    state.status === "draft_confirmed" &&
    Boolean(state.bookingDraft) &&
    !state.booking,
  run: async (state, context) => {
    if (!state.bookingDraft) return {};

    const booking = await context.call("connectors.maintenance.confirmBooking", { draft: state.bookingDraft });
    return {
      booking,
      bookingDraft: null,
      status: "booked",
      messages: [{
        role: "tool",
        name: "connectors.maintenance.confirmBooking",
        call: { draftId: state.bookingDraft.id },
        result: booking,
      } satisfies WorkflowToolMessage],
    };
  },
});

// The render step generates the final assistant message based on the updated state and context. It does not update state or call connectors.
// The templates field defines reusable response fragments that the render step can use to construct the final message, but using templates is optional.
export default render({
  name: "maintenance_reply",
  progress: "正在生成回复",
  // templates: [
  //   {id: "card:dealer_selection", name: "dealer_selection", description: "门店选择提示卡片，展示门店候选项供用户选择", schema: z.array(DealerSchema)},
  //   {id: "card:slot_selection", name: "slot_selection", description: "时段选择提示卡片，展示可预约时段供用户选择", schema: z.array(SlotSchema)},
  //   {id: "card:booking_confirmation", name: "booking_confirmation", description: "预约确认提示卡片，展示预约草稿信息并询问用户是否确认提交", schema: z.object({
  //     vehicle: VehicleSchema,
  //     dealer: DealerSchema,
  //     slot: SlotSchema,
  //   })},
  // ],
  instruction: `
Write the next concise Chinese reply for a car maintenance booking assistant.

Reply rules:
1. If the user cancelled, briefly say the current maintenance booking flow has stopped or been cancelled.
2. If the latest tool result is connectors.maintenance.confirmBooking, report the confirmed booking and include "预约成功".
3. If the latest tool result is connectors.maintenance.createBookingDraft, show vehicle, dealer, and arrival time, then ask whether to confirm submission.
4. If the latest tool result is connectors.maintenance.getAvailableSlots, list the available arrival slots and ask the user to choose one.
5. If the latest tool result is connectors.maintenance.getDealerCandidates, the vehicle is already resolved; ask the user to choose or confirm a dealer and list the dealer options. Do not ask the user to choose a vehicle.
6. If no vehicle has been resolved and no dealer candidates are available, list the vehicles and ask which vehicle to book.
7. If vehicle and dealer are resolved but no appointment date/time is available, ask only for the desired appointment time.
8. If the user asks a follow-up about the dealer, slot, vehicle, or draft, answer it before asking for the next action.
9. If the user asks about service items, maintenance contents, or price, explain that this booking workflow only confirms vehicle, dealer, and arrival time; service details are handled by a later procedure.

Offer candidates as choices, not as selected facts, unless the conversation or booking data already confirms the choice.
Do not recommend service items or prices in this booking workflow.
Return concise Chinese. Number options when listing choices. No markdown, internal state names, JSON, or workflow terms.
  `,
});

function maintenanceFacts(context: MaintenanceContext): Partial<MaintenanceFacts> {
  const facts: Partial<MaintenanceFacts> = {};
  const customer = context.get<Customer>("customer");
  const vehicles = context.get<Vehicle[]>("vehicles");
  const recentDealer = context.get<Dealer | null>("recentDealer");

  if (customer !== undefined) facts.customer = customer;
  if (vehicles !== undefined) facts.vehicles = vehicles;
  if (recentDealer !== undefined) facts.recentDealer = recentDealer;

  return facts;
}

function availabilityCacheKey(dealer: Dealer, preferredDate: DateRange): string {
  return `${dealer.id}:${preferredDate.start}:${preferredDate.end}`;
}

function selectionMatchesBooking(state: MaintenanceState): boolean {
  if (!state.booking || !state.vehicle || !state.dealer || !state.slot) return false;
  return (
    state.vehicle.id === state.booking.vehicle.id &&
    state.dealer.id === state.booking.dealer.id &&
    state.slot.id === state.booking.slot.id
  );
}
