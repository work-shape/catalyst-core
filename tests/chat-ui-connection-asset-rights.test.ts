// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { resolveBuildRights, type BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";

// RIGHTS-1d in Studio: a person may hold write on one Connection and nothing on the kind. The
// page then asks the right on that Connection, which the instance names in the asset's
// `allowed`: its switches, exposure boxes and approval list are there for a writer of this
// Connection and absent for a reader of it.

const WAIT = { timeout: CONDITION_WAIT_MS };

afterEach(async () => {
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const OPERATIONS = [
  { name: "revenue_by_month", effect: "reading", exposure: ["agent"], enabled: true },
  { name: "list_customers", effect: "reading", exposure: ["agent", "workflow"], enabled: true }
];

const PASTED = ["- name: list_clients", "  method: GET", "  path: /clients"].join("\n");

/** The asset as the instance sends it to a reader who holds `allowed` on it. */
function held(asset: BuildAsset, allowed: NonNullable<BuildAsset["allowed"]>): BuildAsset {
  return { ...asset, allowed };
}

/**
 * The page of `asset` for a plain user who holds nothing on the kind: the platform context
 * names no Connection action. Counts the requests for the connector types and keeps every save.
 */
async function openPage(asset: BuildAsset) {
  const puts: Record<string, unknown>[] = [];
  const asked = { connectorTypes: 0 };
  const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
  const page = await mountBuildPage(
    asset,
    "connections",
    (request, url) => {
      if (url.pathname === apiOperations["platform.context.get"].path) {
        return Response.json(platformContext());
      }
      if (url.pathname === apiOperations["connections.connector_types"].path) {
        asked.connectorTypes += 1;
        return Response.json({ items: [] });
      }
      if (request.method === "GET" && url.pathname === detailPath) {
        return Response.json(connectionDetail(asset.name));
      }
      return undefined;
    },
    [],
    {
      put: async (input) => {
        if ("config" in input) puts.push(input.config);
        return { revision: puts.length + 1 };
      }
    }
  );
  await vi.waitFor(
    () => expect(page.querySelector("[data-connection-operation]")).not.toBeNull(),
    WAIT
  );
  return { page, puts, asked };
}

function typeInto(field: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("A Connection page for a person with write on this Connection only", () => {
  it("offers the switches and the exposure boxes and asks for the connector types", async () => {
    const asset = held(
      connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS }),
      ["read", "write"]
    );
    const { page, puts, asked } = await openPage(asset);
    expect(page.querySelector("[data-build-read-only]")).toBeNull();
    expect(page.querySelector('[data-connection-enabled="revenue_by_month"]')).not.toBeNull();
    expect(page.querySelector('[data-connection-exposure="bridge:list_customers"]')).not.toBeNull();
    expect(page.querySelector('[data-connection-outside="list_customers"]')).not.toBeNull();
    await vi.waitFor(() => expect(asked.connectorTypes).toBeGreaterThan(0), WAIT);
    await act(async () =>
      page.querySelector<HTMLButtonElement>('[data-connection-enabled="revenue_by_month"]')?.click()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
  });

  it("approves pasted tools through the approval list", async () => {
    const asset = held(
      connectionAsset("exampledata", {
        origin: "runtime",
        connectorType: "http_api",
        settings: { baseUrl: "https://gateway.example.test/api" },
        operations: OPERATIONS
      }),
      ["read", "write"]
    );
    const { page, puts } = await openPage(asset);
    await vi.waitFor(
      () => expect(page.querySelector("[data-connection-paste]")).not.toBeNull(),
      WAIT
    );
    await act(async () =>
      page.querySelector<HTMLButtonElement>("[data-connection-paste] button")?.click()
    );
    const field = document.querySelector<HTMLTextAreaElement>(
      "[data-connection-paste-field] textarea, textarea[data-connection-paste-field]"
    );
    if (!field) throw new Error("The paste field is open");
    await act(async () => typeInto(field, PASTED));
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-paste-check]")?.click()
    );
    expect(document.querySelector("[data-connection-approval]")).not.toBeNull();
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-approve]")?.click()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(1), WAIT);
  });
});

describe("A Connection page for a person who may only read this Connection", () => {
  it("shows the operations with no switch, box or approval and asks no connector types", async () => {
    const asset = held(
      connectionAsset("sample-business", { origin: "runtime", operations: OPERATIONS }),
      ["read"]
    );
    const { page, asked } = await openPage(asset);
    expect(page.querySelector("[data-connection-enabled]")).toBeNull();
    expect(page.querySelector("[data-connection-remove]")).toBeNull();
    expect(page.querySelector("[data-connection-exposure]")).toBeNull();
    expect(page.querySelector("[data-connection-outside]")).toBeNull();
    expect(page.querySelector("[data-connection-paste]")).toBeNull();
    expect(page.querySelector("[data-connection-approval]")).toBeNull();
    // Give the page a moment: a request it would send has been sent by now.
    await act(async () => new Promise((done) => setTimeout(done, 50)));
    expect(asked.connectorTypes).toBe(0);
  });

  it("offers no paste on a REST API", async () => {
    const asset = held(
      connectionAsset("exampledata", {
        origin: "runtime",
        connectorType: "http_api",
        settings: { baseUrl: "https://gateway.example.test/api" },
        operations: OPERATIONS
      }),
      ["read"]
    );
    const { page } = await openPage(asset);
    expect(page.querySelector("[data-connection-paste]")).toBeNull();
    expect(page.querySelector("[data-connection-approval]")).toBeNull();
  });
});

describe("Who may make a Connection in Studio", () => {
  const withConnections = (actions: string[]) => {
    const base = platformContext([], actions);
    return {
      ...base,
      kinds: [
        ...base.kinds,
        {
          kind: "connection",
          plural: "connections",
          lifecycle: "active" as const,
          representation: "config" as const,
          owners: ["instance" as const],
          actions: {
            read: "connection.read",
            write: "connection.write",
            delete: "connection.delete"
          }
        }
      ]
    };
  };

  it("is whoever holds connection.write on the whole instance, not the legacy key", () => {
    expect(
      resolveBuildRights({ permissions: [] }, withConnections(["connection.write"])).mayCreate(
        "connection"
      )
    ).toBe(true);
    expect(
      resolveBuildRights({ permissions: ["config_assets.write"] }, withConnections([])).mayCreate(
        "connection"
      )
    ).toBe(false);
  });

  it("leaves agents to the keys they had", () => {
    expect(
      resolveBuildRights({ permissions: ["config_assets.write"] }, withConnections([])).mayCreate(
        "agent"
      )
    ).toBe(true);
    expect(
      resolveBuildRights({ permissions: [] }, withConnections(["connection.write"])).mayCreate(
        "agent"
      )
    ).toBe(false);
  });
});
