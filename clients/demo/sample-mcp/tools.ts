import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SampleData } from "./data.js";
import { toolError, toolResult } from "./result.js";

export const DEFAULT_LIMIT = 50;
export const MINIMUM_LIMIT = 1;
export const MAXIMUM_LIMIT = 200;
export const DEFAULT_TOP_LIMIT = 5;
export const MAXIMUM_TOP_LIMIT = 40;

const segmentSchema = z.enum(["retail", "hospitality", "office"]);
const orderStatusSchema = z.enum(["open", "shipped", "cancelled"]);
const invoiceStatusSchema = z.enum(["open", "paid", "overdue"]);
const dateSchema = z.iso.date();
const centsSchema = z.number().int().positive();
const customerSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  segment: segmentSchema,
  city: z.string(),
  country: z.string().regex(/^[A-Z]{2}$/u)
});
const orderSchema = z.strictObject({
  id: z.string(),
  date: dateSchema,
  customerId: z.string(),
  status: orderStatusSchema,
  lineCount: z.number().int().positive(),
  netTotalCents: centsSchema,
  currency: z.literal("EUR")
});
const invoiceSchema = z.strictObject({
  id: z.string(),
  date: dateSchema,
  dueDate: dateSchema,
  orderId: z.string(),
  customerId: z.string(),
  status: invoiceStatusSchema,
  totalCents: centsSchema,
  currency: z.literal("EUR")
});
const totalSchema = z.number().int().nonnegative();
export const outputSchemas = {
  list_customers: z.strictObject({ rows: z.array(customerSchema), total: totalSchema }),
  get_customer: z.strictObject({
    customer: customerSchema,
    recentOrders: z.array(orderSchema),
    openInvoices: z.array(invoiceSchema)
  }),
  list_orders: z.strictObject({ rows: z.array(orderSchema), total: totalSchema }),
  list_invoices: z.strictObject({ rows: z.array(invoiceSchema), total: totalSchema }),
  revenue_by_month: z.strictObject({
    rows: z
      .array(
        z.strictObject({
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
          revenueCents: z.number().int().nonnegative(),
          orders: totalSchema
        })
      )
      .length(12)
  }),
  top_customers: z.strictObject({
    rows: z.array(
      z.strictObject({
        rank: z.number().int().positive(),
        customer: customerSchema,
        revenueCents: z.number().int().nonnegative(),
        orders: totalSchema
      })
    ),
    total: totalSchema
  })
};

const paging = {
  limit: z.number().int().min(MINIMUM_LIMIT).max(MAXIMUM_LIMIT).default(DEFAULT_LIMIT),
  offset: z.number().int().nonnegative().default(0)
};
const dateRange = { from: dateSchema.optional(), to: dateSchema.optional() };

function inRange(date: string, range: { from?: string; to?: string }): boolean {
  return (
    (range.from === undefined || date >= range.from) && (range.to === undefined || date <= range.to)
  );
}

function page<T>(rows: T[], { limit, offset }: { limit: number; offset: number }) {
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}

export function registerSampleTools(server: McpServer, data: SampleData): void {
  server.registerTool(
    "list_customers",
    {
      title: "List customers",
      description: "Find sample customers by name or segment with pagination.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        search: z.string().optional(),
        segment: segmentSchema.optional(),
        ...paging
      }),
      outputSchema: outputSchemas.list_customers
    },
    (input) =>
      toolResult(
        page(
          data.customers.filter(
            (customer) =>
              (input.search === undefined ||
                customer.name.toLowerCase().includes(input.search.toLowerCase())) &&
              (input.segment === undefined || customer.segment === input.segment)
          ),
          input
        )
      )
  );

  server.registerTool(
    "get_customer",
    {
      title: "Get customer",
      description: "Read one sample customer, its ten newest orders and unpaid invoices.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({ id: z.string() }),
      outputSchema: outputSchemas.get_customer
    },
    ({ id }) => {
      const customer = data.customers.find((row) => row.id === id);
      if (!customer) return toolError("The sample customer was not found.");
      return toolResult({
        customer,
        recentOrders: data.orders.filter((order) => order.customerId === id).slice(0, 10),
        openInvoices: data.invoices.filter(
          (invoice) => invoice.customerId === id && invoice.status !== "paid"
        )
      });
    }
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "Read sample orders by customer, status and inclusive order dates, newest first.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        customerId: z.string().optional(),
        status: orderStatusSchema.optional(),
        ...dateRange,
        ...paging
      }),
      outputSchema: outputSchemas.list_orders
    },
    (input) =>
      toolResult(
        page(
          data.orders.filter(
            (order) =>
              (input.customerId === undefined || order.customerId === input.customerId) &&
              (input.status === undefined || order.status === input.status) &&
              inRange(order.date, input)
          ),
          input
        )
      )
  );

  server.registerTool(
    "list_invoices",
    {
      title: "List invoices",
      description:
        "Read sample invoices by customer, status and inclusive invoice dates, newest first.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        customerId: z.string().optional(),
        status: invoiceStatusSchema.optional(),
        ...dateRange,
        ...paging
      }),
      outputSchema: outputSchemas.list_invoices
    },
    (input) =>
      toolResult(
        page(
          data.invoices.filter(
            (invoice) =>
              (input.customerId === undefined || invoice.customerId === input.customerId) &&
              (input.status === undefined || invoice.status === input.status) &&
              inRange(invoice.date, input)
          ),
          input
        )
      )
  );

  server.registerTool(
    "revenue_by_month",
    {
      title: "Revenue by month",
      description:
        "Sum net order revenue excluding cancellations across twelve full months. Date and segment filters keep empty months at zero.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({ ...dateRange, segment: segmentSchema.optional() }),
      outputSchema: outputSchemas.revenue_by_month
    },
    (input) => {
      const customers = new Set(
        data.customers
          .filter((customer) => input.segment === undefined || customer.segment === input.segment)
          .map((customer) => customer.id)
      );
      const orders = data.orders.filter(
        (order) =>
          order.status !== "cancelled" &&
          customers.has(order.customerId) &&
          inRange(order.date, input)
      );
      return toolResult({
        rows: data.months.map((month) => {
          const monthlyOrders = orders.filter((order) => order.date.startsWith(month));
          return {
            month,
            revenueCents: monthlyOrders.reduce((sum, order) => sum + order.netTotalCents, 0),
            orders: monthlyOrders.length
          };
        })
      });
    }
  );

  server.registerTool(
    "top_customers",
    {
      title: "Top customers",
      description:
        "Rank customers by summed net order revenue excluding cancellations, highest first, within inclusive order dates. The total counts every customer with an order in the period.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        ...dateRange,
        segment: segmentSchema.optional(),
        limit: z.number().int().min(MINIMUM_LIMIT).max(MAXIMUM_TOP_LIMIT).default(DEFAULT_TOP_LIMIT)
      }),
      outputSchema: outputSchemas.top_customers
    },
    (input) => {
      const sums = new Map<string, { revenueCents: number; orders: number }>();
      for (const order of data.orders) {
        if (order.status === "cancelled" || !inRange(order.date, input)) continue;
        const sum = sums.get(order.customerId) ?? { revenueCents: 0, orders: 0 };
        sum.revenueCents += order.netTotalCents;
        sum.orders += 1;
        sums.set(order.customerId, sum);
      }
      const ranked = data.customers
        .filter((customer) => input.segment === undefined || customer.segment === input.segment)
        .flatMap((customer) => {
          const sum = sums.get(customer.id);
          return sum ? [{ customer, ...sum }] : [];
        })
        .sort(
          (left, right) =>
            right.revenueCents - left.revenueCents ||
            left.customer.id.localeCompare(right.customer.id)
        );
      return toolResult({
        rows: ranked.slice(0, input.limit).map((row, index) => ({ rank: index + 1, ...row })),
        total: ranked.length
      });
    }
  );
}
