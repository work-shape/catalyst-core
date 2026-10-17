import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ClientRow, FiscalYearRow } from "./clients.js";
import type { Posting } from "./postings.js";
import { accountingRestOptionsSchema, type AccountingRestOptions } from "./rest-options.js";
import type { AccountingSample } from "./sample.js";
import { ACCOUNTING_DEFAULT_PAGE_SIZE, ACCOUNTING_MAXIMUM_PAGE_SIZE } from "./tools.js";

const ACCOUNTING_REST_INSTANCE_ID = "demo-local";
const PROFILE_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  "team-a": [1001, 1300],
  "team-b": [1301, 1600]
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function number(value: string, name: string, minimum = 1): number {
  if (!/^\d+$/u.test(value)) throw new RequestError(400, `${name} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new RequestError(400, `${name} must be a safe whole number from ${minimum}.`);
  return parsed;
}

function one(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  if (values.length > 1) throw new RequestError(400, `${name} must occur once.`);
  return values[0];
}

function page(query: URLSearchParams, gateway: boolean) {
  const sizeName = gateway ? "top" : "page_size";
  const size = number(one(query, sizeName) ?? String(ACCOUNTING_DEFAULT_PAGE_SIZE), sizeName);
  if (size > ACCOUNTING_MAXIMUM_PAGE_SIZE)
    throw new RequestError(400, `${sizeName} must be at most ${ACCOUNTING_MAXIMUM_PAGE_SIZE}.`);
  const offset = gateway
    ? number(one(query, "skip") ?? "0", "skip", 0)
    : (number(one(query, "page") ?? "1", "page") - 1) * size;
  if (!Number.isSafeInteger(offset + size))
    throw new RequestError(400, "Page offset is too large.");
  return { offset, size };
}

function only(query: URLSearchParams, names: readonly string[]) {
  for (const name of query.keys()) {
    if (!names.includes(name)) throw new RequestError(400, "Unsupported query parameter.");
  }
}

function gatewayClient(client: ClientRow) {
  // Exampledata's Gateway example: https://api.exampledata.com/docs/gateway (2026-10-17).
  return {
    id: String(client.client_id),
    number: client.client_number,
    name: client.name,
    status: "active",
    organization_number: 2_906_417
  };
}

function gatewayYear(year: FiscalYearRow) {
  // DATEV's public Accounting 1.7.4 portal did not expose its schema without its app.
  // Keep the Enterprise fields; `id` supplies the fiscalYearId used in Gateway paths.
  return { ...year, id: String(year.fiscal_year) };
}

type Filter = {
  field: "client_id" | "date" | "fiscal_year";
  operator: "eq" | "gte" | "lt";
  value: string;
};

function filters(query: URLSearchParams): Filter[] {
  return query.getAll("filter").map((value) => {
    const match = /^(client_id|date|fiscal_year) (eq|gte|lt) (\S+)$/u.exec(value);
    const parsed = z
      .object({
        field: z.enum(["client_id", "date", "fiscal_year"]),
        operator: z.enum(["eq", "gte", "lt"]),
        value: z.string()
      })
      .safeParse({ field: match?.[1], operator: match?.[2], value: match?.[3] });
    if (!parsed.success)
      throw new RequestError(400, "Unsupported filter; use field eq, gte or lt value.");
    const filter = parsed.data;
    if (filter.field === "date") {
      if (!z.iso.date().safeParse(filter.value).success)
        throw new RequestError(400, "date must be YYYY-MM-DD.");
    } else if (filter.field === "fiscal_year") {
      if (
        !/^\d{8}$/u.test(filter.value) ||
        !z.iso
          .date()
          .safeParse(
            `${filter.value.slice(0, 4)}-${filter.value.slice(4, 6)}-${filter.value.slice(6)}`
          ).success
      )
        throw new RequestError(400, "fiscal_year must be YYYYMMDD.");
    } else number(filter.value, "client_id");
    return filter;
  });
}

function matches(value: string | number, filter: Filter): boolean {
  const right = typeof value === "number" ? Number(filter.value) : filter.value;
  return filter.operator === "eq"
    ? value === right
    : filter.operator === "gte"
      ? value >= right
      : value < right;
}

function monthEnd(month: string): string {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0))
    .toISOString()
    .slice(0, 10);
}

/** Walk ledger periods in order, generating only the requested page (and rows skipped by a partial date filter). */
function postings(
  sample: AccountingSample,
  clients: ClientRow[],
  queryFilters: Filter[],
  offset: number,
  size: number,
  fiscalYear?: string
): Posting[] {
  const rows: Posting[] = [];
  const dateFilters = queryFilters.filter((filter) => filter.field === "date");
  for (const client of clients) {
    const years = sample.fiscalYears(client.client_id);
    for (const month of sample.months) {
      const first = `${month}-01`;
      const last = monthEnd(month);
      const year = years.find(
        (year) =>
          first.replaceAll("-", "") >= String(year.fiscal_year_start) &&
          first.replaceAll("-", "") <= String(year.fiscal_year_end)
      );
      if (!year || (fiscalYear !== undefined && String(year.fiscal_year) !== fiscalYear)) continue;
      if (
        !queryFilters
          .filter((filter) => filter.field === "fiscal_year")
          .every((filter) => matches(String(year.fiscal_year), filter))
      )
        continue;
      if (
        dateFilters.some((filter) =>
          filter.operator === "eq"
            ? filter.value < first || filter.value > last
            : filter.operator === "gte"
              ? filter.value > last
              : filter.value <= first
        )
      )
        continue;
      const count = sample.postingCount(client.client_id, month);
      // Complete ledger months retain planted wrong-date bookings, just like list_postings.
      // This sample models ledger selection; it is not a DATEV filter implementation.
      const wholeMonth = dateFilters.every((filter) =>
        filter.operator === "gte"
          ? filter.value <= first
          : filter.operator === "lt" && filter.value > last
      );
      if (wholeMonth) {
        if (offset >= count) {
          offset -= count;
          continue;
        }
        const pageRows = sample.postings(client.client_id, month, offset, size - rows.length);
        rows.push(...pageRows);
        offset = 0;
      } else {
        for (let position = 0; position < count; position += ACCOUNTING_MAXIMUM_PAGE_SIZE) {
          const chunk = sample.postings(
            client.client_id,
            month,
            position,
            ACCOUNTING_MAXIMUM_PAGE_SIZE
          );
          for (const row of chunk) {
            const ledgerDate = row.date < first ? first : row.date > last ? last : row.date;
            if (!dateFilters.every((filter) => matches(ledgerDate, filter))) continue;
            if (offset > 0) {
              offset--;
              continue;
            }
            rows.push(row);
            if (rows.length === size) return rows;
          }
        }
      }
      if (rows.length === size) return rows;
    }
  }
  return rows;
}

/** REST and MCP share this exact sample. Auth, profile scope and paging apply before generating rows. */
export function createAccountingRest(
  sample: AccountingSample,
  options: AccountingRestOptions = {}
) {
  const knobs = accountingRestOptionsSchema.parse(options);
  let windowStart = 0;
  let calls = 0;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    authorized: boolean
  ): Promise<void> => {
    try {
      if (!authorized) {
        response.setHeader("WWW-Authenticate", "Bearer");
        json(response, 401, {
          message: "Authentication failed",
          error: "Unauthorized",
          statusCode: 401
        });
        return;
      }
      if (request.headers["x-client-instance-id"] !== ACCOUNTING_REST_INSTANCE_ID)
        throw new RequestError(400, "x-client-instance-id must identify the demo-local instance.");
      const profile = request.headers["x-profile-id"] ?? "service-account";
      if (
        typeof profile !== "string" ||
        (profile !== "service-account" && !Object.hasOwn(PROFILE_RANGES, profile))
      )
        throw new RequestError(403, "Unknown profile.");
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        throw new RequestError(405, "Use GET.");
      }
      const url = new URL(request.url ?? "/", "http://sample.invalid");
      const query = url.searchParams;
      const gateway = url.pathname.startsWith("/rest/datevconnect/");
      const health = /^\/rest\/api\/monitoring\/instance\/([^/]+)\/datev-connect-health$/u.exec(
        url.pathname
      );
      const clientList =
        url.pathname === "/rest/api/accounting/clients" ||
        url.pathname === "/rest/datevconnect/master-data/v1/clients";
      const enterpriseYears = /^\/rest\/api\/accounting\/clients\/(\d+)\/fiscal-years$/u.exec(
        url.pathname
      );
      const gatewayPath =
        /^\/rest\/datevconnect\/accounting\/v1\/clients\/(\d+)\/fiscal-years(?:\/(\d+)\/(account-postings))?$/u.exec(
          url.pathname
        );
      const enterprisePostings = url.pathname === "/rest/api/accounting/postings";
      if (!health && !clientList && !enterpriseYears && !gatewayPath && !enterprisePostings)
        throw new RequestError(404, "Not found.");
      const range = profile === "service-account" ? undefined : PROFILE_RANGES[profile];
      let clients = sample.clients.filter(
        (client) =>
          range === undefined || (client.client_id >= range[0] && client.client_id <= range[1])
      );
      const clientPath = enterpriseYears?.[1] ?? gatewayPath?.[1];
      const queryFilters = enterprisePostings ? filters(query) : [];
      if (clientPath !== undefined)
        clients = clients.filter((client) => client.client_id === number(clientPath, "clientId"));
      clients = clients.filter((client) =>
        queryFilters
          .filter((filter) => filter.field === "client_id")
          .every((filter) => matches(client.client_id, filter))
      );
      if (clientPath !== undefined && clients.length === 0)
        throw new RequestError(404, "Client not found.");
      const pagingNames = gateway ? ["top", "skip"] : ["page", "page_size"];
      only(query, health ? [] : [...pagingNames, ...(enterprisePostings ? ["filter"] : [])]);
      const paging = page(query, gateway);
      if (health && health[1] !== ACCOUNTING_REST_INSTANCE_ID)
        throw new RequestError(404, "Instance not found.");
      if (
        gatewayPath?.[2] !== undefined &&
        !clients.some((client) =>
          sample
            .fiscalYears(client.client_id)
            .some((year) => String(year.fiscal_year) === gatewayPath[2])
        )
      )
        throw new RequestError(404, "Fiscal year not found.");
      if (knobs.latencyMs > 0) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once("close", abort);
        try {
          await delay(knobs.latencyMs, undefined, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        } finally {
          response.off("close", abort);
        }
      }
      if (response.destroyed) return;
      // Health never consumes fault-injection calls or exposes accounting data.
      if (health) {
        json(response, 200, [{ status: "online", service: "datev-connect" }]);
        return;
      }
      if (
        knobs.unavailable ||
        (knobs.unavailableClientId !== undefined &&
          clients.some((client) => client.client_id === knobs.unavailableClientId) &&
          (clientPath !== undefined || enterprisePostings))
      ) {
        json(response, 503, {
          statusCode: 503,
          code: "connector_unavailable",
          message:
            "The request could not be completed because the connector connection is unavailable or was interrupted."
        });
        return;
      }
      const now = Date.now();
      if (now - windowStart >= knobs.rateWindowMs) {
        windowStart = now;
        calls = 0;
      }
      calls++;
      if (knobs.rateLimitAfter > 0 && calls > knobs.rateLimitAfter) {
        response.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil((windowStart + knobs.rateWindowMs - now) / 1000)))
        );
        throw new RequestError(429, "Too Many Requests");
      }
      if (clientList) {
        const rows = clients.slice(paging.offset, paging.offset + paging.size);
        json(response, 200, gateway ? rows.map(gatewayClient) : rows);
      } else if (enterpriseYears || (gatewayPath?.[2] === undefined && gatewayPath)) {
        const rows = clients
          .flatMap((client) => sample.fiscalYears(client.client_id))
          .slice(paging.offset, paging.offset + paging.size);
        json(response, 200, gateway ? rows.map(gatewayYear) : rows);
      } else {
        // Gateway posting fields deliberately retain the Enterprise names (see gatewayYear).
        json(
          response,
          200,
          postings(sample, clients, queryFilters, paging.offset, paging.size, gatewayPath?.[2])
        );
      }
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      json(response, error.status, { statusCode: error.status, message: error.message });
    }
  };
}
