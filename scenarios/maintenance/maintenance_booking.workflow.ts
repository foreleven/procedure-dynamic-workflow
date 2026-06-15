import {
  ToolMessage,
  loadWorkflowMetadata,
  type WorkflowContext,
  workflow,
  z,
} from "@pac/workflow";
import type { MaintenanceConnectorCatalog } from "./connectors.js";

const VehicleSchema = z.object({
  id: z.string(), label: z.string(), make: z.string(), model: z.string(), year: z.number(),
  trim: z.string(), vinLast6: z.string(), plateNumber: z.string(), mileage: z.number(),
  powertrain: z.enum(["gasoline", "hybrid", "electric"]), nextRecommendedServiceMileage: z.number(),
}).describe("Full vehicle record already present in runtime context or message history; never invent vehicle fields.");

const DealerSchema = z.object({
  id: z.string(), name: z.string(), city: z.string(), address: z.string(), phone: z.string(),
  brands: z.array(z.string()), distanceKm: z.number(),
  serviceLevel: z.enum(["brand_certified", "independent_specialist", "ev_specialist"]),
  openingHours: z.string(),
}).describe("Full dealer record selected by the user from known dealer candidates; never invent dealer fields.");

const DateRangeSchema = z.object({
  label: z.string().describe("Original user phrase for the desired appointment window, for example 明天下午."),
  start: z.string().describe("Inclusive local ISO datetime with +08:00 offset for the start of the desired window."),
  end: z.string().describe("Exclusive local ISO datetime with +08:00 offset for the end of the desired window."),
}).describe("Desired appointment date/time window extracted from the latest user message; this is not a concrete available slot.");

const SlotSchema = z.object({
  id: z.string(), label: z.string(), startsAt: z.string(), endsAt: z.string(),
  dealerId: z.string(), advisorName: z.string(), bayType: z.string(),
}).describe("Concrete arrival slot selected by the user from displayed available slots; never set from a vague date window.");

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
]).describe("Current maintenance booking flow status.");

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
const { patch, prefetch, effect, command, render } = workflow<
  MaintenanceState,
  MaintenanceConnectorCatalog
>({
  ...metadata,
  stateSchema: MaintenanceStateSchema,
  state: maintenanceInitialState,
});

// Patch steps only update state according to the instruction and user's latest message; they do not call connectors or generate final responses.
patch({
  progress: "正在思考",
  state: {
    status: MaintenanceStatusSchema.describe("Set cancelled only for explicit cancellation; set draft_confirmed only for explicit draft confirmation."),
    vehicle: VehicleSchema.describe("Selected full vehicle object, copied exactly from known vehicle facts."),
    dealer: DealerSchema.describe("Selected full dealer object, copied exactly from known dealer candidates."),
    preferredDate: DateRangeSchema.describe("Desired appointment date/time window from the latest user message, e.g. 明天下午 -> +08:00 local ISO range."),
    slot: SlotSchema.describe("Concrete displayed arrival slot selected by the user after available slots are shown."),
  },
  invalidates: maintenanceInvalidation,
  instruction: `
Extract only these maintenance booking state fields: status, vehicle, dealer, preferredDate, and slot.

You are extracting state, not replying to the user. Never generate a user-facing answer, XML/DSML, connector calls, or tool-call text.
Use the latest user message as the only source of new facts; use prior assistant questions, tool results, and current state only to resolve references such as "1" or "明天下午".

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
- If vehicle and dealer are already selected and the latest user message only provides a desired appointment date/time such as "明天下午", set preferredDate and leave vehicle, dealer, and slot unchanged unless the user explicitly changes them.
- A desired appointment date/time is not an arrival-slot selection until available slots have been shown.

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

// Effect and command steps can call connectors and update state. Returned messages are appended to the runtime message log.
// Connector calls inside one effect can still run in parallel with Promise.all when the business step allows it.
effect("selectOnlyVehicle", {
  description: "客户名下只有一辆车时直接使用该车辆；多车或只有历史推断时仍由 render 引导用户确认。",
  run: (state, context) => {
    if (state.vehicle || (maintenanceFacts(context).vehicles?.length ?? 0) !== 1) return {};
    const [vehicle] = maintenanceFacts(context).vehicles ?? [];
    if (!vehicle) return {};
    return {
      status: state.status === "cancelled" ? state.status : "collecting",
      vehicle,
      messages: [
        new ToolMessage({
          name: "selectOnlyVehicle",
          call: { reason: "single_vehicle" },
          result: { vehicle },
        }),
      ],
    };
  },
});

effect("dealerCandidates", ["vehicle"], {
  description: "车辆确定或变化后查询支持该品牌/车型的候选门店，并把结果作为 tool message 写入 messages；候选项不进入长期业务 state。",
  run: async (state, context, _runtime, step) => {
    if (!state.vehicle) return {};
    const loading = step.start("查询候选门店");
    const input = {
      vehicle: state.vehicle,
    };
    const dealerCandidates = await context.call("connectors.maintenance.getDealerCandidates", input, {
      cache: true,
    });
    loading.end({ count: dealerCandidates.length });

    return {
      messages: [
        new ToolMessage({
          name: "connectors.maintenance.getDealerCandidates",
          call: { vehicleId: state.vehicle.id },
          result: dealerCandidates,
        }),
      ],
    };
  },
});

effect("appointmentAvailability", ["dealer", "preferredDate"], {
  description: "门店或期望时间确定/变化后查询真实可用时段，并把候选时段作为 tool message 写入 messages，等待用户选择具体到店时间。",
  run: async (state, context, _runtime, step) => {
    if (!state.dealer || !state.preferredDate) return {};
    const loading = step.start("查询可预约时段");
    const input = {
      dealer: state.dealer,
      dateRange: state.preferredDate,
    };
    const availableSlots = await context.call("connectors.maintenance.getAvailableSlots", input, {
      cache: true,
    });
    loading.end({ count: availableSlots.length });

    return {
      messages: [
        new ToolMessage({
          name: "connectors.maintenance.getAvailableSlots",
          call: {
            dealerId: state.dealer.id,
            start: state.preferredDate.start,
            end: state.preferredDate.end,
          },
          result: availableSlots,
        }),
      ],
    };
  },
});

effect("prepareBookingDraft", ["status", "vehicle", "dealer", "preferredDate", "slot", "bookingDraft"], {
  description: "车辆、门店、期望时间和用户确认的具体时段齐备后创建待确认草稿；草稿不是正式预约，服务项目由其他 procedure 处理。",
  run: async (state, context, _runtime, step) => {
    if (
      state.status === "cancelled" ||
      selectionMatchesBooking(state) ||
      !state.vehicle ||
      !state.dealer ||
      !state.preferredDate ||
      !state.slot ||
      state.bookingDraft
    ) {
      return {};
    }

    const loading = step.start("创建预约草稿");
    const bookingDraft = await context.call("connectors.maintenance.createBookingDraft", {
      vehicle: state.vehicle,
      dealer: state.dealer,
      slot: state.slot,
    });
    loading.end({ draftId: bookingDraft.id });

    return {
      bookingDraft,
      status: "draft_ready",
      messages: [
        new ToolMessage({
          name: "connectors.maintenance.createBookingDraft",
          call: {
            vehicleId: state.vehicle.id,
            dealerId: state.dealer.id,
            slotId: state.slot.id,
          },
          result: bookingDraft,
        }),
      ],
    };
  },
});

command("commitBooking", {
  description: "只有用户明确确认草稿后才调用正式确认接口；这是不可逆的外部提交动作。",
  when: (state) =>
    state.status === "draft_confirmed" &&
    Boolean(state.bookingDraft) &&
    !state.booking,
  run: async (state, context, _runtime, step) => {
    if (!state.bookingDraft) return {};

    const loading = step.start("确认正式预约");
    const booking = await context.call("connectors.maintenance.confirmBooking", { draft: state.bookingDraft });
    loading.end({ bookingId: booking.id });
    return {
      booking,
      bookingDraft: null,
      status: "booked",
      messages: [
        new ToolMessage({
          name: "connectors.maintenance.confirmBooking",
          call: { draftId: state.bookingDraft.id },
          result: booking,
        }),
      ],
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
Use the current workflow state from the runtime render context as authoritative. Tool results are supporting facts only; do not treat older candidate tool results as an unresolved choice when the current state already contains the selected object.

1. If the user cancelled, briefly say the current maintenance booking flow has stopped or been cancelled.
2. If the latest tool result is connectors.maintenance.confirmBooking, report the confirmed booking and include "预约成功".
3. If the latest tool result is connectors.maintenance.createBookingDraft, show vehicle, dealer, and arrival time, then ask whether to confirm submission.
4. If vehicle and dealer are resolved but preferredDate is null, ask only for the desired appointment date/time. Do not ask the user to choose a dealer again, and do not try to query slots.
5. If the latest tool result is connectors.maintenance.getAvailableSlots and preferredDate is resolved, list the available arrival slots and ask the user to choose one.
6. If the latest tool result is connectors.maintenance.getDealerCandidates and dealer is still null, the vehicle is already resolved; ask the user to choose or confirm a dealer and list the dealer options. Do not ask the user to choose a vehicle.
7. If no vehicle has been resolved and no dealer candidates are available, list the vehicles and ask which vehicle to book.
8. If the user asks a follow-up about the dealer, slot, vehicle, or draft, answer it before asking for the next action.
9. If the user asks about service items, maintenance contents, or price, explain that this booking workflow only confirms vehicle, dealer, and arrival time; service details are handled by a later procedure.

Offer candidates as choices, not as selected facts, unless the conversation or booking data already confirms the choice.
Do not recommend service items or prices in this booking workflow.
Return concise Chinese. Number options when listing choices. No markdown, internal state names, JSON, workflow terms, DSML, XML-like tags, or tool-call markup.
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

function selectionMatchesBooking(state: MaintenanceState): boolean {
  if (!state.booking || !state.vehicle || !state.dealer || !state.slot) return false;
  return (
    state.vehicle.id === state.booking.vehicle.id &&
    state.dealer.id === state.booking.dealer.id &&
    state.slot.id === state.booking.slot.id
  );
}
