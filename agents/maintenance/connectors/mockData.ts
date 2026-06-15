import type {
  Customer,
  DealerRef,
  MaintenanceHistoryItem,
  VehicleRef,
} from "./main.js";

export interface MockSlotTemplate {
  id: string;
  startsAtTime: string;
  estimatedMinutes: number;
  advisorName: string;
  bayType: string;
}

export const mockCustomers: Record<string, Customer> = {
  user_feng: {
    id: "user_feng",
    name: "Feng",
    city: "Hoboken",
    tier: "vip",
    phone: "+1-201-555-0188",
    email: "feng@example.com",
    preferredLanguage: "zh-CN",
    homeZipCode: "07030",
  },
  user_alex: {
    id: "user_alex",
    name: "Alex Chen",
    city: "Jersey City",
    tier: "standard",
    phone: "+1-551-555-0129",
    email: "alex.chen@example.com",
    preferredLanguage: "en-US",
    homeZipCode: "07302",
  },
  user_wang: {
    id: "user_wang",
    name: "Wang Li",
    city: "Brooklyn",
    tier: "vip",
    phone: "+1-718-555-0166",
    email: "li.wang@example.com",
    preferredLanguage: "zh-CN",
    homeZipCode: "11201",
  },
};

export const mockVehiclesByUser: Record<string, VehicleRef[]> = {
  user_feng: [
    {
      id: "veh_bmw_x3",
      label: "BMW X3 xDrive30i",
      make: "BMW",
      model: "X3",
      year: 2023,
      trim: "xDrive30i",
      vinLast6: "8K2173",
      plateNumber: "NJ-FX3023",
      mileage: 28600,
      powertrain: "gasoline",
      nextRecommendedServiceMileage: 30000,
    },
  ],
  user_alex: [
    {
      id: "veh_audi_q5",
      label: "Audi Q5 Premium Plus",
      make: "Audi",
      model: "Q5",
      year: 2022,
      trim: "Premium Plus",
      vinLast6: "Q51248",
      plateNumber: "NJ-AQ5022",
      mileage: 41280,
      powertrain: "gasoline",
      nextRecommendedServiceMileage: 45000,
    },
    {
      id: "veh_tesla_model_y",
      label: "Tesla Model Y Long Range",
      make: "Tesla",
      model: "Model Y",
      year: 2024,
      trim: "Long Range",
      vinLast6: "TY9821",
      plateNumber: "NJ-EV9821",
      mileage: 11850,
      powertrain: "electric",
      nextRecommendedServiceMileage: 12500,
    },
  ],
  user_wang: [
    {
      id: "veh_mini_cooper",
      label: "MINI Cooper S",
      make: "MINI",
      model: "Cooper S",
      year: 2021,
      trim: "Iconic",
      vinLast6: "MC7112",
      plateNumber: "NY-MC7112",
      mileage: 33740,
      powertrain: "gasoline",
      nextRecommendedServiceMileage: 35000,
    },
  ],
};

export const mockDealers: Record<string, DealerRef> = {
  dealer_hoboken_bmw: {
    id: "dealer_hoboken_bmw",
    name: "Hoboken BMW Service",
    city: "Hoboken",
    address: "100 Observer Hwy, Hoboken, NJ 07030",
    phone: "+1-201-555-0300",
    brands: ["BMW", "MINI"],
    distanceKm: 1.8,
    serviceLevel: "brand_certified",
    openingHours: "Mon-Fri 08:00-18:00, Sat 09:00-15:00",
  },
  dealer_manhattan_bmw: {
    id: "dealer_manhattan_bmw",
    name: "Manhattan BMW Service Center",
    city: "New York",
    address: "555 W 57th St, New York, NY 10019",
    phone: "+1-212-555-0199",
    brands: ["BMW", "MINI"],
    distanceKm: 6.4,
    serviceLevel: "brand_certified",
    openingHours: "Mon-Sat 08:00-18:30",
  },
  dealer_jersey_euro: {
    id: "dealer_jersey_euro",
    name: "Jersey City European Auto Care",
    city: "Jersey City",
    address: "245 Marin Blvd, Jersey City, NJ 07302",
    phone: "+1-551-555-0441",
    brands: ["BMW", "Audi", "Mercedes-Benz", "Volkswagen"],
    distanceKm: 3.2,
    serviceLevel: "independent_specialist",
    openingHours: "Mon-Fri 07:30-17:30",
  },
  dealer_brooklyn_mini: {
    id: "dealer_brooklyn_mini",
    name: "Brooklyn MINI Service",
    city: "Brooklyn",
    address: "89 Atlantic Ave, Brooklyn, NY 11201",
    phone: "+1-718-555-0212",
    brands: ["MINI", "BMW"],
    distanceKm: 8.9,
    serviceLevel: "brand_certified",
    openingHours: "Mon-Fri 08:00-18:00, Sun 10:00-14:00",
  },
  dealer_newport_ev: {
    id: "dealer_newport_ev",
    name: "Newport EV Service Studio",
    city: "Jersey City",
    address: "35 River Dr S, Jersey City, NJ 07310",
    phone: "+1-551-555-0788",
    brands: ["Tesla", "Rivian", "Polestar"],
    distanceKm: 2.4,
    serviceLevel: "ev_specialist",
    openingHours: "Mon-Sat 09:00-19:00",
  },
};

export const mockRecentDealerByUser: Record<string, string> = {
  user_feng: "dealer_hoboken_bmw",
  user_alex: "dealer_jersey_euro",
  user_wang: "dealer_brooklyn_mini",
};

export const mockMaintenanceHistoryByUser: Record<string, MaintenanceHistoryItem[]> = {
  user_feng: [
    {
      id: "hist_001",
      vehicleId: "veh_bmw_x3",
      serviceTypeId: "oil_service",
      dealerId: "dealer_hoboken_bmw",
      completedAt: "2025-06-21",
      mileage: 12600,
      summary: "更换机油、机滤，完成车辆软件版本检查。",
      invoiceAmountCents: 21900,
    },
    {
      id: "hist_002",
      vehicleId: "veh_bmw_x3",
      serviceTypeId: "basic_oil_inspection",
      dealerId: "dealer_hoboken_bmw",
      completedAt: "2025-12-18",
      mileage: 20500,
      summary: "基础保养、机油检查、轮胎换位、制动片厚度检查。",
      invoiceAmountCents: 38900,
    },
  ],
  user_alex: [
    {
      id: "hist_101",
      vehicleId: "veh_audi_q5",
      serviceTypeId: "basic_oil_inspection",
      dealerId: "dealer_jersey_euro",
      completedAt: "2025-09-05",
      mileage: 33820,
      summary: "30k mile maintenance, cabin filter replacement, brake fluid check.",
      invoiceAmountCents: 46500,
    },
    {
      id: "hist_102",
      vehicleId: "veh_tesla_model_y",
      serviceTypeId: "ev_health_check",
      dealerId: "dealer_newport_ev",
      completedAt: "2026-02-12",
      mileage: 8200,
      summary: "Tire rotation, battery health scan, wiper replacement.",
      invoiceAmountCents: 15900,
    },
  ],
  user_wang: [
    {
      id: "hist_201",
      vehicleId: "veh_mini_cooper",
      serviceTypeId: "oil_service",
      dealerId: "dealer_brooklyn_mini",
      completedAt: "2025-10-30",
      mileage: 27880,
      summary: "机油保养、空调滤芯检查。",
      invoiceAmountCents: 24500,
    },
  ],
};

export const mockSlotTemplatesByDealer: Record<string, MockSlotTemplate[]> = {
  dealer_hoboken_bmw: [
    {
      id: "hoboken_am_0930",
      startsAtTime: "09:30",
      estimatedMinutes: 90,
      advisorName: "Mia Torres",
      bayType: "express",
    },
    {
      id: "hoboken_am_1100",
      startsAtTime: "11:00",
      estimatedMinutes: 90,
      advisorName: "Mia Torres",
      bayType: "standard",
    },
    {
      id: "hoboken_pm_1430",
      startsAtTime: "14:30",
      estimatedMinutes: 90,
      advisorName: "Daniel Kim",
      bayType: "standard",
    },
    {
      id: "hoboken_pm_1600",
      startsAtTime: "16:00",
      estimatedMinutes: 90,
      advisorName: "Daniel Kim",
      bayType: "standard",
    },
  ],
  dealer_manhattan_bmw: [
    {
      id: "manhattan_am_1000",
      startsAtTime: "10:00",
      estimatedMinutes: 90,
      advisorName: "Grace Liu",
      bayType: "standard",
    },
    {
      id: "manhattan_pm_1500",
      startsAtTime: "15:00",
      estimatedMinutes: 90,
      advisorName: "Grace Liu",
      bayType: "standard",
    },
  ],
  dealer_jersey_euro: [
    {
      id: "jersey_am_0830",
      startsAtTime: "08:30",
      estimatedMinutes: 75,
      advisorName: "Owen Patel",
      bayType: "express",
    },
    {
      id: "jersey_pm_1330",
      startsAtTime: "13:30",
      estimatedMinutes: 90,
      advisorName: "Owen Patel",
      bayType: "standard",
    },
    {
      id: "jersey_pm_1530",
      startsAtTime: "15:30",
      estimatedMinutes: 90,
      advisorName: "Nora Smith",
      bayType: "standard",
    },
  ],
  dealer_brooklyn_mini: [
    {
      id: "brooklyn_am_0930",
      startsAtTime: "09:30",
      estimatedMinutes: 75,
      advisorName: "Ethan Wong",
      bayType: "express",
    },
    {
      id: "brooklyn_pm_1430",
      startsAtTime: "14:30",
      estimatedMinutes: 90,
      advisorName: "Ethan Wong",
      bayType: "standard",
    },
  ],
  dealer_newport_ev: [
    {
      id: "newport_ev_am_1000",
      startsAtTime: "10:00",
      estimatedMinutes: 70,
      advisorName: "Sofia Rivera",
      bayType: "ev",
    },
    {
      id: "newport_ev_pm_1400",
      startsAtTime: "14:00",
      estimatedMinutes: 70,
      advisorName: "Sofia Rivera",
      bayType: "ev",
    },
    {
      id: "newport_ev_pm_1630",
      startsAtTime: "16:30",
      estimatedMinutes: 70,
      advisorName: "Leo Grant",
      bayType: "ev",
    },
  ],
};
