// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createApiClient,
  type ApiClient,
  type EffectivePermissions,
  type HolderRights,
  type ScopeAssignmentsOverview
} from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  DataScopes,
  EffectiveRights,
  effectiveRightAreas,
  grantOptions,
  INSTANCE_GRANT_KINDS
} from "@work-shape/catalyst-chat-ui/access";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// AP-5b2: the User screen lists what the server decided, by area, each line with its place
// and its origin. Nothing here decides; the decision is read in access-effective-rights.

const role = {
  source: "role",
  roleId: "role-buchhaltung",
  effect: "allow"
} as const;

function asset(id: string, kind: string, name: string) {
  return { scopeKind: "asset", scopeId: id, scopeAsset: { kind, name, active: true } } as const;
}

const rights: HolderRights = {
  holderActive: true,
  roles: [{ id: "role-buchhaltung", name: "Buchhaltung", builtIn: false }],
  rights: [
    {
      action: "app.use",
      ...asset("app-1", "app", "Rechnungen"),
      allowed: true,
      grantedBy: [{ ...role, ...asset("app-1", "app", "Rechnungen") }]
    },
    {
      action: "app.use",
      ...asset("app-2", "app", "Belege"),
      allowed: false,
      reason: "denied",
      grantedBy: [{ ...role, ...asset("app-2", "app", "Belege") }],
      deniedBy: { source: "grant", effect: "deny", scopeKind: "instance" }
    },
    {
      action: "connection.use",
      ...asset("connection-1", "connection", "DATEV"),
      allowed: true,
      grantedBy: [{ ...role, ...asset("connection-1", "connection", "DATEV") }]
    },
    {
      action: "agent.write",
      scopeKind: "asset",
      scopeId: "agent-1",
      scopeAsset: { kind: "agent", name: "ledger_helper", title: "Ledger Helper", active: true },
      allowed: true,
      grantedBy: [{ source: "grant", effect: "allow", scopeKind: "asset", scopeId: "agent-1" }]
    }
  ]
};

describe("the effective rights of a person", () => {
  it("group by kind in the order of the rights screens, one line per place", () => {
    expect(effectiveRightAreas(rights.rights).map((area) => [area.area, area.rows.length])).toEqual(
      [
        ["agent", 1],
        ["connection", 1],
        ["app", 2]
      ]
    );
  });

  it("show the server's decision per place, an asset by its title, and never an id", () => {
    const html = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(EffectiveRights, { rights })
      )
    );
    expect(html.match(/data-allowed="true"/g)).toHaveLength(3);
    expect(html.match(/data-allowed="false"/g)).toHaveLength(1);
    expect(html).toContain("Ledger Helper");
    expect(html).not.toContain("ledger_helper");
    expect(html).not.toMatch(/>[^<]*(role-buchhaltung|app\.use|connection\.use)[^<]*</);
  });
});

const scopesApi = { apiBaseUrl: "http://localhost", authScope: "test" };
const row = (
  holderKind: "user" | "group" | "service_principal",
  holderId: string,
  values: "all" | string[],
  effect: "allow" | "deny" = "allow"
) => ({ dimension: "mandant", holderKind, holderId, effect, values });

const overview: ScopeAssignmentsOverview = {
  dimensions: { mandant: { label: "Mandant", valueType: "text" as const } },
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

function scopesTree(client: ApiClient) {
  const query = new QueryClient();
  query.setQueryData(["data-scope-overview", scopesApi.apiBaseUrl, scopesApi.authScope], overview);
  query.setQueryData(
    ["service-principals", scopesApi.apiBaseUrl, scopesApi.authScope],
    [
      {
        principal: { id: "sp-1", displayLabel: "Nightly import", status: "active" },
        credentials: []
      }
    ]
  );
  return createElement(QueryClientProvider, {
    client: query,
    children: createElement(TranslationProvider, {
      locale: "en",
      children: createElement(DataScopes, { api: { ...scopesApi, client }, userId: "admin" })
    })
  });
}

describe("Instance > Access > Data access", () => {
  it("offers no change of the reader's own row", () => {
    const markup = renderToStaticMarkup(
      scopesTree(createApiClient({ baseUrl: scopesApi.apiBaseUrl }))
    );
    expect(markup).not.toContain('aria-label="Change Mandant for Admin"');
    expect(markup).toContain('aria-label="Change Mandant for Cem Celik"');
  });

  describe("changing a holder's values", () => {
    let root: Root | undefined;
    let host: HTMLElement | undefined;
    afterEach(() => {
      act(() => root?.unmount());
      host?.remove();
    });

    it("adds a value and saves the person's values, leaving the revocation alone", async () => {
      const written: unknown[] = [];
      const client = createApiClient({
        baseUrl: scopesApi.apiBaseUrl,
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
        root?.render(
          createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, scopesTree(client))
        )
      );
      const edit = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Change Mandant for Anna Albers"]'
      );
      await act(async () => edit?.click());
      const dialog = document.querySelector("dialog");
      const chips = dialog?.querySelector<HTMLInputElement>("[data-chip-input] input");
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
});

const assets = {
  app: {
    failed: false,
    items: [
      {
        id: "app-a",
        name: "A",
        resource: { kind: "app", name: "app-a", assetId: "app-a", workspaceId: "w-a" }
      },
      {
        id: "app-b",
        name: "B",
        resource: { kind: "app", name: "app-b", assetId: "app-b", workspaceId: "w-b" }
      }
    ]
  }
};
const workspaces = {
  failed: false,
  items: [
    { id: "w-a", name: "A" },
    { id: "w-b", name: "B" }
  ]
};
const entries = (items: EffectivePermissions["items"]): EffectivePermissions => ({
  holderActive: true,
  items
});
const allow = (
  action: string,
  scopeKind: "asset" | "workspace" | "instance",
  scopeId?: string
): EffectivePermissions["items"][number] => ({
  action,
  effect: "allow",
  scopeKind,
  ...(scopeId === undefined ? {} : { scopeId }),
  source: "grant"
});

describe("the giver's grant choices", () => {
  it("offers nothing before rights load or for an inactive giver", () => {
    expect(grantOptions(undefined, assets, workspaces).kinds).toEqual([]);
    expect(
      grantOptions(
        { holderActive: false, items: [allow("app.write", "instance")] },
        assets,
        workspaces
      ).kinds
    ).toEqual([]);
  });
  it("does not widen an asset right or borrow a verb from another asset", () => {
    const options = grantOptions(
      entries([allow("app.read", "asset", "app-a"), allow("app.write", "asset", "app-b")]),
      assets,
      workspaces
    );
    expect(options.places("app", [])).toEqual(["asset"]);
    expect(options.verbs("app", "asset", "app-a")).toEqual(["read"]);
    expect(options.choices("app", "asset", ["write"]).map((x) => x.id)).toEqual(["app-b"]);
    expect(options.choices("app", "asset", ["read", "write"])).toEqual([]);
  });
  it("offers a workspace right only there and on its owned assets", () => {
    const options = grantOptions(
      entries([allow("app.write", "workspace", "w-a")]),
      assets,
      workspaces
    );
    expect(options.places("app", ["write"])).toEqual(["workspace", "asset"]);
    expect(options.choices("app", "workspace", ["write"]).map((x) => x.id)).toEqual(["w-a"]);
    expect(options.choices("app", "asset", ["write"]).map((x) => x.id)).toEqual(["app-a"]);
  });
  it("a deny removes the containing broad scope, but leaves another workspace available", () => {
    const options = grantOptions(
      entries([
        allow("app.write", "instance"),
        { ...allow("app.write", "asset", "app-a"), effect: "deny" }
      ]),
      assets,
      workspaces
    );
    expect(options.places("app", ["write"])).toEqual(["workspace", "asset"]);
    expect(options.choices("app", "workspace", ["write"]).map((x) => x.id)).toEqual(["w-b"]);
    expect(options.verbs("app", "asset", "app-a")).toEqual([]);
  });
  it("does not assume where a deny belongs when its asset cannot be loaded", () => {
    const options = grantOptions(
      entries([
        allow("app.write", "instance"),
        { ...allow("app.write", "asset", "hidden"), effect: "deny" }
      ]),
      assets,
      workspaces
    );
    expect(options.places("app", ["write"])).toEqual(["asset"]);
  });
  it("does not ignore a scoped deny when only an asset id is visible", () => {
    const hidden = { app: { failed: false, items: [{ id: "a", name: "a" }] } };
    const granted = allow("app.write", "asset", "a");
    expect(grantOptions(entries([granted]), hidden, workspaces).places("app", ["write"])).toEqual([
      "asset"
    ]);
    expect(
      grantOptions(
        entries([
          granted,
          {
            action: "app.write",
            effect: "deny",
            scopeKind: "workspace",
            scopeId: "w-b",
            source: "grant"
          }
        ]),
        hidden,
        workspaces
      ).places("app", ["write"])
    ).toEqual([]);
  });
});

describe("rights held only through membership or availability", () => {
  const workflows = {
    workflow: {
      failed: false,
      items: [
        {
          id: "flow-a",
          name: "A",
          resource: { kind: "workflow", name: "flow-a", assetId: "flow-a" }
        }
      ]
    }
  };
  const member = (
    action: string,
    scopeKind: "asset" | "workspace",
    scopeId: string
  ): EffectivePermissions["items"][number] => ({
    action,
    effect: "allow",
    scopeKind,
    scopeId,
    source: "membership"
  });

  it("are not offered to hand on", () => {
    expect(
      grantOptions(entries([member("workflow.use", "asset", "flow-a")]), workflows, workspaces)
        .kinds
    ).toEqual([]);
    expect(
      grantOptions(entries([member("app.read", "workspace", "w-a")]), assets, workspaces).kinds
    ).toEqual([]);
  });
  it("leave an explicit allow on the same place offered", () => {
    const options = grantOptions(
      entries([
        member("workflow.use", "asset", "flow-a"),
        allow("workflow.use", "asset", "flow-a")
      ]),
      workflows,
      workspaces
    );
    expect(options.verbs("workflow", "asset", "flow-a")).toEqual(["use"]);
  });
  it("never outweigh a deny", () => {
    const options = grantOptions(
      entries([
        member("workflow.use", "asset", "flow-a"),
        allow("workflow.use", "instance"),
        { ...allow("workflow.use", "asset", "flow-a"), effect: "deny" }
      ]),
      workflows,
      workspaces
    );
    expect(options.verbs("workflow", "asset", "flow-a")).toEqual([]);
  });

  it("offers service principals on the whole instance to who holds the right, and not past a deny (RIGHTS-1f)", () => {
    // What the Access page hands the dialog for the kinds that name no asset.
    const instanceKinds = Object.fromEntries(
      INSTANCE_GRANT_KINDS.map((kind) => [kind, { failed: false, items: [] }])
    );
    expect(INSTANCE_GRANT_KINDS).toContain("service_principals");
    const role = (action: string): EffectivePermissions["items"][number] => ({
      ...allow(action, "instance"),
      source: "role"
    });
    const holder = grantOptions(
      entries([role("service_principals.manage")]),
      instanceKinds,
      workspaces
    );
    expect(holder.kinds).toEqual(["service_principals"]);
    expect(holder.places("service_principals", [])).toEqual(["instance"]);
    expect(holder.verbs("service_principals", "instance")).toEqual(["manage"]);

    expect(grantOptions(entries([role("users.manage")]), instanceKinds, workspaces).kinds).toEqual(
      []
    );
    const denied = grantOptions(
      entries([
        role("service_principals.manage"),
        { ...allow("service_principals.manage", "instance"), effect: "deny" }
      ]),
      instanceKinds,
      workspaces
    );
    expect(denied.kinds).not.toContain("service_principals");
  });
});
