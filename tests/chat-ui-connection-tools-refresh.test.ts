// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { connectionAsset, connectionDetail } from "./chat-ui-connection-fixtures";

// ACCEPT-2e: after "2 Tools freigeben" the Connection page said "Operationen 0" until it read
// the Connection again, and the first click on approve in the list page's dialog sent nothing.

afterEach(async () => {
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const PASTED = [
  "- name: list_clients",
  "  method: GET",
  "  path: /clients",
  "- name: list_months",
  "  method: GET",
  "  path: /months"
].join("\n");

function typeInto(field: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("The tools of a REST API approved on its page", () => {
  it("count on the page as soon as the save is in, without waiting for a later read", async () => {
    const asset = connectionAsset("exampledata", {
      origin: "runtime",
      connectorType: "http_api",
      settings: { baseUrl: "https://gateway.example.test/datevconnect" }
    });
    const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
    let operations: ConnectionDetail["operations"] = [];
    const page = await mountBuildPage(
      asset,
      "connections",
      (request, url) =>
        request.method === "GET" && url.pathname === detailPath
          ? Response.json(connectionDetail(asset.name, { operations }))
          : undefined,
      [],
      {
        put: async (input) => {
          const written = input.config.operations;
          operations = (Array.isArray(written) ? written : []).map((operation: unknown) => {
            const name =
              typeof operation === "object" && operation !== null && "name" in operation
                ? String(operation.name)
                : "";
            return {
              name,
              toolName: `connection.${asset.name}.${name}`,
              effect: "reading",
              exposure: ["agent"],
              enabled: true,
              status: "ready"
            };
          });
          return { revision: 2 };
        }
      }
    );
    const section = () => page.querySelector("section#operations, #operations");
    await vi.waitFor(() => expect(page.querySelector("[data-connection-paste]")).not.toBeNull(), {
      timeout: 5000
    });
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
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-approve]")?.click()
    );
    expect(operations.map((operation) => operation.name)).toEqual(["list_clients", "list_months"]);
    // The page reads its Connection again every 2 s while it waits: the count is there before.
    await vi.waitFor(
      () => expect(section()?.textContent ?? "").toMatch(/^Operations2.*List months/u),
      { timeout: 1000, interval: 50 }
    );
  });
});

describe("A REST API made in the list page's dialog", () => {
  it("saves the pasted tools with the first click on approve, then opens the Connection", async () => {
    const asset = connectionAsset("exampledata", {
      origin: "runtime",
      connectorType: "http_api",
      settings: { baseUrl: "https://gateway.example.test/datevconnect" }
    });
    const testPath = apiOperations["connections.test"].path.replace(":name", asset.name);
    const detailPath = apiOperations["connections.get"].path.replace(":name", asset.name);
    const puts: Record<string, unknown>[] = [];
    const opened: { kindPath?: string; name?: string }[] = [];
    const page = await mountBuildPage(
      asset,
      "connections",
      (request, url) =>
        url.pathname === testPath
          ? Response.json({ status: "ready", testedAt: "2026-10-19T09:00:00.000Z" })
          : request.method === "GET" && url.pathname === detailPath
            ? Response.json(connectionDetail(asset.name, { operations: [] }))
            : undefined,
      [],
      {
        put: async (input) => {
          puts.push(input.config);
          return { revision: puts.length };
        },
        list: { opened }
      }
    );
    const button = (root: ParentNode, text: string) =>
      [...root.querySelectorAll("button")].find((found) => found.textContent?.trim() === text);
    await vi.waitFor(() => expect(button(page, "New connection")).toBeDefined(), {
      timeout: 5000
    });
    await act(async () => button(page, "New connection")?.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-connection-type="http_api"] button')?.click()
    );
    const input = (selector: string) =>
      document.querySelector<HTMLInputElement>(`input${selector}, ${selector} input`);
    const typeIn = (field: HTMLInputElement | null, value: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(field, value);
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => typeIn(input('[data-name-with-address-field="name"]'), "Exampledata"));
    await act(async () =>
      typeIn(input('[data-connection-field="url"]'), "https://gateway.example.test/datevconnect")
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-connect]")?.click()
    );
    await vi.waitFor(
      () => expect(document.querySelector("[data-connection-paste] button")).not.toBeNull(),
      { timeout: 5000 }
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-paste] button")?.click()
    );
    const field = document.querySelector<HTMLTextAreaElement>(
      "[data-connection-paste-field] textarea, textarea[data-connection-paste-field]"
    );
    if (!field) throw new Error("The paste field is open");
    await act(async () => typeInto(field, PASTED));
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-paste-check]")?.click()
    );
    expect(puts).toHaveLength(1);
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-connection-approve]")?.click()
    );
    await vi.waitFor(() => expect(puts).toHaveLength(2), { timeout: 1000 });
    expect(opened.at(-1)).toEqual({ kindPath: "connections", name: "exampledata" });
  });
});
