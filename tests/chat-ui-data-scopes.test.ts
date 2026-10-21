// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createApiClient,
  type ApiClient,
  type ScopeAssignmentsOverview
} from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { DataScopes } from "@work-shape/catalyst-chat-ui/access";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const api = { apiBaseUrl: "http://localhost", authScope: "test" };
const mandant = { mandant: { label: "Mandant", valueType: "text" as const } };
const row = (
  holderKind: "user" | "group" | "service_principal",
  holderId: string,
  values: "all" | string[],
  effect: "allow" | "deny" = "allow"
) => ({ dimension: "mandant", holderKind, holderId, effect, values });

const overview: ScopeAssignmentsOverview = {
  dimensions: mandant,
  assignments: [
    row("user", "anna", ["101", "102"]),
    row("group", "Steuerberatung", ["103"]),
    row("user", "ben", ["104"], "deny"),
    row("service_principal", "sp-1", "all")
  ],
  people: [
    { id: "admin", displayLabel: "Admin", groups: [], effective: { mandant: [] } },
    { id: "anna", displayLabel: "Anna Albers", groups: [], effective: { mandant: ["101", "102"] } },
    {
      id: "ben",
      displayLabel: "Ben Brandt",
      groups: ["Steuerberatung"],
      effective: { mandant: ["103"] }
    },
    { id: "cem", displayLabel: "Cem Celik", groups: [], effective: { mandant: [] } }
  ]
};

function seeded(data: ScopeAssignmentsOverview) {
  const query = new QueryClient();
  query.setQueryData(["data-scope-overview", api.apiBaseUrl, api.authScope], data);
  query.setQueryData(
    ["service-principals", api.apiBaseUrl, api.authScope],
    [
      {
        principal: { id: "sp-1", displayLabel: "Nightly import", status: "active" },
        credentials: []
      }
    ]
  );
  return query;
}

function tree(locale: "en" | "de", client: ApiClient, data = overview) {
  return createElement(QueryClientProvider, {
    client: seeded(data),
    children: createElement(TranslationProvider, {
      locale,
      children: createElement(DataScopes, { api: { ...api, client }, userId: "admin" })
    })
  });
}

const noClient = createApiClient({ baseUrl: api.apiBaseUrl });

describe("Instance > Access > Data access", () => {
  it("lists every person and holder with their values and where they come from, in German and English", () => {
    const de = renderToStaticMarkup(tree("de", noClient));
    for (const text of [
      "Anna Albers",
      "101, 102",
      "direkt zugeordnet",
      "über Gruppe Steuerberatung",
      "Kein Mandant zugeordnet",
      "Nie gezeigt",
      "Nightly import",
      "Technisches Konto",
      "Alle Werte",
      "2 Personen ohne Werte"
    ])
      expect(de, text).toContain(text);
    const en = renderToStaticMarkup(tree("en", noClient));
    for (const text of ["assigned directly", "through group Steuerberatung", "No Mandant assigned"])
      expect(en, text).toContain(text);
    // No raw id is a name, and no comma-separated text field is left.
    expect(de).not.toContain(">sp-1<");
    expect(de).not.toContain("durch Komma getrennt");
  });

  it("marks a person without values and offers no change of the reader's own row", () => {
    const rows = renderToStaticMarkup(tree("en", noClient)).split('data-testid="scope-row"');
    const unassigned = rows
      .filter((entry) => entry.includes("No Mandant assigned"))
      .map((entry) => /<span class="truncate">([^<]+)<\/span>/u.exec(entry)?.[1]);
    expect(unassigned).toEqual(["Admin", "Cem Celik"]);
    const ben = rows.find((entry) => entry.includes("Ben Brandt")) ?? "";
    expect(ben).toContain("through group Steuerberatung");
    expect(ben).toContain("Never shown");
    expect(ben).toContain("104");
    const markup = renderToStaticMarkup(tree("en", noClient));
    expect(markup).not.toContain('aria-label="Change Mandant for Admin"');
    expect(markup).toContain('aria-label="Change Mandant for Cem Celik"');
    expect(markup).toContain("Your own assignment is changed by another person");
  });
});

describe("changing a holder's values", () => {
  let root: Root | undefined;
  let host: HTMLElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  it("adds a value as a chip and saves the person's values, leaving the revocation alone", async () => {
    const written: unknown[] = [];
    const client = createApiClient({
      baseUrl: api.apiBaseUrl,
      fetchImpl: async (_url, init) => {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (init?.method === "PUT") written.push(body);
        return new Response(JSON.stringify(init?.method === "PUT" ? body : overview), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root?.render(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, tree("en", client)))
    );
    const edit = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Change Mandant for Anna Albers"]'
    );
    await act(async () => edit?.click());
    const dialog = document.querySelector("dialog");
    expect(dialog?.textContent).toContain("Mandant for Anna Albers");
    const chips = dialog?.querySelector<HTMLInputElement>("[data-chip-input] input");
    expect(dialog?.querySelector("[data-chip-input]")?.textContent).toContain("101");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(chips, "105,");
      chips?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Save"
    );
    await act(async () => save?.click());
    await act(async () => undefined);
    expect(written).toEqual([
      {
        dimension: "mandant",
        holderKind: "user",
        holderId: "anna",
        effect: "allow",
        values: ["101", "102", "105"]
      }
    ]);
  });
});
