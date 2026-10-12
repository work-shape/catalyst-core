import { z } from "zod";
import { pick, seededGenerator } from "./random.js";

const SAMPLE_SEED = 0x7a31b295;
const DAY_MS = 86_400_000;
const anchorSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);

interface Customer {
  id: string;
  name: string;
  segment: "retail" | "hospitality" | "office";
  city: string;
  country: string;
}

interface Order {
  id: string;
  date: string;
  customerId: string;
  status: "open" | "shipped" | "cancelled";
  lineCount: number;
  netTotalCents: number;
  currency: "EUR";
}

interface Invoice {
  id: string;
  date: string;
  dueDate: string;
  orderId: string;
  customerId: string;
  status: "open" | "paid" | "overdue";
  totalCents: number;
  currency: "EUR";
}

export interface SampleData {
  customers: Customer[];
  orders: Order[];
  invoices: Invoice[];
  months: string[];
}

export function utcMonthAnchor(date: Date): string {
  return anchorSchema.parse(date.toISOString().slice(0, 7));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function newestFirst(
  left: { date: string; id: string },
  right: { date: string; id: string }
): number {
  return right.date.localeCompare(left.date) || left.id.localeCompare(right.id);
}

export function createSampleData(anchor: string): SampleData {
  const start = new Date(`${anchorSchema.parse(anchor)}-01T00:00:00.000Z`);
  const random = seededGenerator(SAMPLE_SEED);
  const prefixes = [
    "Velunara",
    "Tavolumi",
    "Meruvika",
    "Solunefi",
    "Naluvora",
    "Pelumari",
    "Rovunela",
    "Lumavoti"
  ];
  const suffixes = ["Fenvilo", "Nuvarek", "Talumet", "Vesulon", "Mirevul"];
  const forms = ["GmbH", "AG", "KG"];
  const segments = ["retail", "hospitality", "office"] as const;
  const places = [
    { city: "Hamburg", country: "DE" },
    { city: "Vienna", country: "AT" },
    { city: "Prague", country: "CZ" },
    { city: "Utrecht", country: "NL" },
    { city: "Lyon", country: "FR" },
    { city: "Ghent", country: "BE" }
  ];
  const customers: Customer[] = Array.from({ length: 40 }, (_, index) => ({
    id: `C-${String(index + 1).padStart(4, "0")}`,
    name: `${pick(prefixes, Math.floor(index / suffixes.length))} ${pick(suffixes, index)} ${pick(forms, index)}`,
    segment: pick(segments, Math.floor(random() * segments.length)),
    ...pick(places, Math.floor(random() * places.length))
  }));
  const monthStarts = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(start);
    date.setUTCMonth(date.getUTCMonth() - 12 + index);
    return date;
  });
  const months = monthStarts.map(utcMonthAnchor);
  const season = [1, 0.95, 1, 1, 1.05, 0.9, 0.8, 0.85, 1.1, 1.15, 1.2, 1.2];
  const weights = monthStarts.map((date) => pick(season, date.getUTCMonth()));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const orders: Order[] = [];
  const invoices: Invoice[] = [];
  let allocated = 0;
  for (const [monthIndex, monthStart] of monthStarts.entries()) {
    const nextMonth = new Date(monthStart);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const days = Math.round((nextMonth.getTime() - monthStart.getTime()) / DAY_MS);
    const count =
      monthIndex === 11
        ? 600 - allocated
        : Math.round((600 * pick(weights, monthIndex)) / weightTotal);
    allocated += count;
    for (let index = 0; index < count; index += 1) {
      const number = orders.length + 1;
      const date = new Date(monthStart.getTime() + Math.floor(random() * days) * DAY_MS);
      // The first three customers receive twelve times the weight of each other customer.
      const ticket = Math.floor(random() * 73);
      const customer = pick(customers, ticket < 36 ? Math.floor(ticket / 12) : ticket - 33);
      const cancelled = number % 20 === 0;
      const recentlyPlaced = start.getTime() - date.getTime() <= 21 * DAY_MS;
      const order: Order = {
        id: `O-${String(number).padStart(6, "0")}`,
        date: isoDate(date),
        customerId: customer.id,
        status: cancelled ? "cancelled" : recentlyPlaced && random() < 0.7 ? "open" : "shipped",
        lineCount: 1 + Math.floor(random() * 12),
        netTotalCents: 5_000 + Math.floor(random() * 245_000),
        currency: "EUR"
      };
      orders.push(order);
      if (order.status !== "shipped") continue;
      const dueDate = isoDate(new Date(date.getTime() + 30 * DAY_MS));
      const unpaid = random() < 0.2;
      invoices.push({
        id: `I-${String(invoices.length + 1).padStart(6, "0")}`,
        date: order.date,
        dueDate,
        orderId: order.id,
        customerId: customer.id,
        status: unpaid ? (dueDate < isoDate(start) ? "overdue" : "open") : "paid",
        totalCents: Math.round(order.netTotalCents * 1.19),
        currency: "EUR"
      });
    }
  }
  return {
    customers,
    orders: orders.sort(newestFirst),
    invoices: invoices.sort(newestFirst),
    months
  };
}
