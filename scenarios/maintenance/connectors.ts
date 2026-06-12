import { createConnectorRegistry, defineConnectorCatalog, defineConnectorRef, defineConnectorTool, z } from "@pac/workflow";
import {
  mockCustomers,
  mockDealers,
  mockMaintenanceHistoryByUser,
  mockRecentDealerByUser,
  mockSlotTemplatesByDealer,
  mockVehiclesByUser,
} from "./mockData.js";

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  tier: z.enum(["standard", "vip"]),
  phone: z.string(),
  email: z.string(),
  preferredLanguage: z.string(),
  homeZipCode: z.string(),
});

export type Customer = z.infer<typeof CustomerSchema>;

export const VehicleRefSchema = z.object({
  id: z.string(),
  label: z.string(),
  make: z.string(),
  model: z.string(),
  year: z.number(),
  trim: z.string(),
  vinLast6: z.string(),
  plateNumber: z.string(),
  mileage: z.number(),
  powertrain: z.enum(["gasoline", "hybrid", "electric"]),
  nextRecommendedServiceMileage: z.number(),
});

export type VehicleRef = z.infer<typeof VehicleRefSchema>;

export const DealerRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  address: z.string(),
  phone: z.string(),
  brands: z.array(z.string()),
  distanceKm: z.number(),
  serviceLevel: z.enum(["brand_certified", "independent_specialist", "ev_specialist"]),
  openingHours: z.string(),
});

export type DealerRef = z.infer<typeof DealerRefSchema>;

export const MaintenanceHistoryItemSchema = z.object({
  id: z.string(),
  vehicleId: z.string(),
  serviceTypeId: z.string(),
  dealerId: z.string(),
  completedAt: z.string(),
  mileage: z.number(),
  summary: z.string(),
  invoiceAmountCents: z.number(),
});

export type MaintenanceHistoryItem = z.infer<typeof MaintenanceHistoryItemSchema>;

export const DateRangeSchema = z.object({
  label: z.string(),
  start: z.string(),
  end: z.string(),
});

export type DateRange = z.infer<typeof DateRangeSchema>;

export const SlotSchema = z.object({
  id: z.string(),
  label: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  dealerId: z.string(),
  advisorName: z.string(),
  bayType: z.string(),
});

export type Slot = z.infer<typeof SlotSchema>;

export const BookingDraftSchema = z.object({
  id: z.string(),
  vehicle: VehicleRefSchema,
  dealer: DealerRefSchema,
  slot: SlotSchema,
  notes: z.array(z.string()),
});

export type BookingDraft = z.infer<typeof BookingDraftSchema>;

export const BookingSchema = z.object({
  id: z.string(),
  confirmationCode: z.string(),
  status: z.enum(["confirmed", "cancelled"]),
  time: z.string(),
  dealerName: z.string(),
  createdAt: z.string(),
  vehicle: VehicleRefSchema,
  dealer: DealerRefSchema,
  slot: SlotSchema,
  notes: z.array(z.string()),
});

export type Booking = z.infer<typeof BookingSchema>;

export const UserIdInputSchema = z.object({
  userId: z.string(),
});

export const DealerCandidatesInputSchema = z.object({
  vehicle: VehicleRefSchema,
});

export const AvailableSlotsInputSchema = z.object({
  dealer: DealerRefSchema,
  dateRange: DateRangeSchema,
});

export const CreateBookingDraftInputSchema = z.object({
  vehicle: VehicleRefSchema,
  dealer: DealerRefSchema,
  slot: SlotSchema,
});

export const ConfirmBookingInputSchema = z.object({
  draft: BookingDraftSchema,
});

export const getCustomerConnector = defineConnectorRef({
  id: "connectors.maintenance.getCustomer",
  description: "Read the current customer profile by user id.",
  inputSchema: UserIdInputSchema,
  outputSchema: CustomerSchema,
});

export const getUserVehiclesConnector = defineConnectorRef({
  id: "connectors.maintenance.getUserVehicles",
  description: "Read vehicles owned by the current user.",
  inputSchema: UserIdInputSchema,
  outputSchema: z.array(VehicleRefSchema),
});

export const getMaintenanceHistoryConnector = defineConnectorRef({
  id: "connectors.maintenance.getMaintenanceHistory",
  description: "Read historical maintenance records for the current user.",
  inputSchema: UserIdInputSchema,
  outputSchema: z.array(MaintenanceHistoryItemSchema),
});

export const getRecentDealerConnector = defineConnectorRef({
  id: "connectors.maintenance.getRecentDealer",
  description: "Read the most recently used dealer for the current user.",
  inputSchema: UserIdInputSchema,
  outputSchema: DealerRefSchema.nullable(),
});

export const getDealerCandidatesConnector = defineConnectorRef({
  id: "connectors.maintenance.getDealerCandidates",
  description: "Read dealer candidates for a vehicle.",
  inputSchema: DealerCandidatesInputSchema,
  outputSchema: z.array(DealerRefSchema),
});

export const getAvailableSlotsConnector = defineConnectorRef({
  id: "connectors.maintenance.getAvailableSlots",
  description: "Read available service slots for a dealer and date range.",
  inputSchema: AvailableSlotsInputSchema,
  outputSchema: z.array(SlotSchema),
});

export const createMaintenanceBookingDraftConnector = defineConnectorRef({
  id: "connectors.maintenance.createBookingDraft",
  description: "Create a booking draft from resolved maintenance appointment details.",
  inputSchema: CreateBookingDraftInputSchema,
  outputSchema: BookingDraftSchema,
});

export const confirmMaintenanceBookingConnector = defineConnectorRef({
  id: "connectors.maintenance.confirmBooking",
  description: "Confirm a maintenance booking draft and return the committed booking.",
  inputSchema: ConfirmBookingInputSchema,
  outputSchema: BookingSchema,
});

export const maintenanceConnectorCatalog = defineConnectorCatalog({
  "connectors.maintenance.getCustomer": getCustomerConnector,
  "connectors.maintenance.getUserVehicles": getUserVehiclesConnector,
  "connectors.maintenance.getMaintenanceHistory": getMaintenanceHistoryConnector,
  "connectors.maintenance.getRecentDealer": getRecentDealerConnector,
  "connectors.maintenance.getDealerCandidates": getDealerCandidatesConnector,
  "connectors.maintenance.getAvailableSlots": getAvailableSlotsConnector,
  "connectors.maintenance.createBookingDraft": createMaintenanceBookingDraftConnector,
  "connectors.maintenance.confirmBooking": confirmMaintenanceBookingConnector,
});

export type MaintenanceConnectorCatalog = typeof maintenanceConnectorCatalog;

export async function getCustomer(userId: string): Promise<Customer> {
  return CustomerSchema.parse(
    mockCustomers[userId] ?? {
      id: userId,
      name: "Guest User",
      city: "Hoboken",
      tier: "standard",
      phone: "+1-201-555-0100",
      email: `${safeEmailLocalPart(userId)}@example.com`,
      preferredLanguage: "zh-CN",
      homeZipCode: "07030",
    },
  );
}

export async function getUserVehicles(userId: string): Promise<VehicleRef[]> {
  return z.array(VehicleRefSchema).parse(mockVehiclesByUser[userId] ?? []);
}

export async function getMaintenanceHistory(userId: string): Promise<MaintenanceHistoryItem[]> {
  return z.array(MaintenanceHistoryItemSchema).parse(mockMaintenanceHistoryByUser[userId] ?? []);
}

export async function getRecentDealer(userId: string): Promise<DealerRef | null> {
  const dealerId = mockRecentDealerByUser[userId];
  return dealerId ? DealerRefSchema.parse(mockDealers[dealerId]) : null;
}

export async function getDealerCandidates(vehicle: VehicleRef): Promise<DealerRef[]> {
  const candidates = Object.values(mockDealers)
    .filter((dealer) => dealer.brands.includes(vehicle.make))
    .sort((left, right) => dealerScore(left) - dealerScore(right));

  return z.array(DealerRefSchema).parse(candidates);
}

export async function getAvailableSlots(input: {
  dealer: DealerRef;
  dateRange: DateRange;
}): Promise<Slot[]> {
  const templates = mockSlotTemplatesByDealer[input.dealer.id] ?? [];
  const windowStart = timeToMinutes(formatIsoTime(input.dateRange.start));
  const windowEnd = timeToMinutes(formatIsoTime(input.dateRange.end));
  const matchingTemplates = templates.filter((slot) => {
    const slotStart = timeToMinutes(slot.startsAtTime);
    return slotStart >= windowStart && slotStart < windowEnd;
  });

  const selectedTemplates =
    matchingTemplates.length > 0
      ? matchingTemplates
      : [
          {
            id: `${input.dealer.id}_fallback`,
            startsAtTime: formatIsoTime(input.dateRange.start),
            estimatedMinutes: 90,
            advisorName: "Service Advisor",
            bayType: "standard",
          },
        ];

  return z.array(SlotSchema).parse(
    selectedTemplates.map((template) => {
      const endsAtTime = addMinutes(template.startsAtTime, template.estimatedMinutes);
      return {
        id: `${template.id}_${dateKey(input.dateRange.start)}`,
        label: `${input.dateRange.label} ${template.startsAtTime}`,
        startsAt: setIsoTime(input.dateRange.start, template.startsAtTime),
        endsAt: setIsoTime(input.dateRange.start, endsAtTime),
        dealerId: input.dealer.id,
        advisorName: template.advisorName,
        bayType: template.bayType,
      };
    }),
  );
}

export async function createMaintenanceBookingDraft(input: {
  vehicle: VehicleRef;
  dealer: DealerRef;
  slot: Slot;
}): Promise<BookingDraft> {
  return BookingDraftSchema.parse({
    id: `draft_${input.vehicle.id}_${input.slot.id}`,
    ...input,
    notes: [
      `${input.vehicle.label} 当前里程 ${input.vehicle.mileage} miles。`,
      `服务顾问：${input.slot.advisorName}。`,
    ],
  });
}

export async function confirmMaintenanceBooking(draft: BookingDraft): Promise<Booking> {
  return BookingSchema.parse({
    id: `booking_${draft.id.replace(/^draft_/, "")}`,
    confirmationCode: confirmationCode(draft),
    status: "confirmed",
    time: draft.slot.label,
    dealerName: draft.dealer.name,
    createdAt: "2026-06-11T10:00:00+08:00",
    vehicle: draft.vehicle,
    dealer: draft.dealer,
    slot: draft.slot,
    notes: draft.notes,
  });
}

export const maintenanceConnectorTools = [
  defineConnectorTool(getCustomerConnector, ({ userId }) => getCustomer(userId)),
  defineConnectorTool(getUserVehiclesConnector, ({ userId }) => getUserVehicles(userId)),
  defineConnectorTool(getMaintenanceHistoryConnector, ({ userId }) => getMaintenanceHistory(userId)),
  defineConnectorTool(getRecentDealerConnector, ({ userId }) => getRecentDealer(userId)),
  defineConnectorTool(getDealerCandidatesConnector, ({ vehicle }) => getDealerCandidates(vehicle)),
  defineConnectorTool(getAvailableSlotsConnector, getAvailableSlots),
  defineConnectorTool(createMaintenanceBookingDraftConnector, createMaintenanceBookingDraft),
  defineConnectorTool(confirmMaintenanceBookingConnector, ({ draft }) => confirmMaintenanceBooking(draft)),
];

export default createConnectorRegistry(maintenanceConnectorTools, maintenanceConnectorCatalog);

function dealerScore(dealer: DealerRef): number {
  const servicePenalty = dealer.serviceLevel === "brand_certified" ? 0 : 10;
  return servicePenalty + dealer.distanceKm;
}

function formatIsoTime(iso: string): string {
  const match = iso.match(/T(\d{2}:\d{2})/);
  return match?.[1] ?? "00:00";
}

function setIsoTime(iso: string, time: string): string {
  return iso.replace(/T\d{2}:\d{2}(:\d{2})?/, `T${time}:00`);
}

function dateKey(iso: string): string {
  return iso.slice(0, 10).replaceAll("-", "");
}

function timeToMinutes(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function addMinutes(time: string, minutesToAdd: number): string {
  const total = timeToMinutes(time) + minutesToAdd;
  const hours = Math.floor(total / 60).toString().padStart(2, "0");
  const minutes = (total % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function confirmationCode(draft: BookingDraft): string {
  const time = formatIsoTime(draft.slot.startsAt).replace(":", "");
  return `PAC-${dateKey(draft.slot.startsAt)}-${draft.vehicle.vinLast6.slice(-3)}-${time}`;
}

function safeEmailLocalPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, ".");
}
