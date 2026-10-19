// The five read operations of the bookkeeping API of ACCEPT-2c E4, as the agent drafted them
// from its OpenAPI: one per GET path, `list_buchungen` fourth. The first approval there saved
// four of them and left out `list_buchungen`; a second approval added it.

const mandantId = { schema: { type: "string" } };
const monat = { required: true, schema: { type: "string", examples: ["2026-09"] } };

export const BOOKKEEPING_OPERATIONS = [
  {
    name: "health",
    title: "Schlüssel prüfen",
    description: "Checks the key; returns no client data.",
    method: "GET",
    path: "/api/health",
    effect: "reading"
  },
  {
    name: "list_mandanten",
    title: "Mandanten auflisten",
    description: "Lists all clients (Mandanten).",
    method: "GET",
    path: "/api/mandanten",
    effect: "reading"
  },
  {
    name: "list_monate",
    title: "Buchungsmonate eines Mandanten auflisten",
    description: "Lists the booking months of a client and their status.",
    method: "GET",
    path: "/api/mandanten/{mandantId}/monate",
    pathParams: { mandantId },
    effect: "reading"
  },
  {
    name: "list_buchungen",
    title: "Buchungen eines Mandanten für einen Monat auflisten",
    description: "Lists the bookings of a client for one month.",
    method: "GET",
    path: "/api/mandanten/{mandantId}/buchungen",
    pathParams: { mandantId },
    query: { monat },
    effect: "reading"
  },
  {
    name: "list_salden",
    title: "Salden eines Mandanten zum Monatsende auflisten",
    description:
      "Account balances of a client at month end, with the bank statement balance where known.",
    method: "GET",
    path: "/api/mandanten/{mandantId}/salden",
    pathParams: { mandantId },
    query: { monat },
    effect: "reading"
  }
] as const;

export const BOOKKEEPING_OPERATION_NAMES = BOOKKEEPING_OPERATIONS.map(({ name }) => name);
