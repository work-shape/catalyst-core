// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import {
  AgentDataStores,
  heldDataStores,
  isAgentDataStoreToolName,
  TranslationProvider,
  withChosenDataStores,
  withDataStoreAccess
} from "./support/chat-ui";

// AGENT-DATA-1: the agent page's "Daten" section gives an agent a Data Store to read, or to read
// and change, and writes it as the store's existing row tools in the agent's tool list.

const READ = [
  "data_store.pruefungen.describe",
  "data_store.pruefungen.query",
  "data_store.pruefungen.preview_rows"
];
const CHANGE = [
  ...READ,
  "data_store.pruefungen.insert",
  "data_store.pruefungen.update",
  "data_store.pruefungen.delete_rows"
];

describe("a Data Store's access, as the agent's tool names", () => {
  it("writes read as the three reading tools and read and change as all six", () => {
    expect(withDataStoreAccess(["web.search"], "pruefungen", "read")).toEqual([
      "web.search",
      ...READ
    ]);
    expect(withDataStoreAccess(["web.search"], "pruefungen", "change")).toEqual([
      "web.search",
      ...CHANGE
    ]);
  });

  it("reads back what the tools add up to, in the order the agent first names its stores", () => {
    expect(
      heldDataStores([
        "data_store.kunden.query",
        "web.search",
        ...CHANGE,
        "data_store.kunden.describe"
      ])
    ).toEqual([
      { store: "kunden", access: "read" },
      { store: "pruefungen", access: "change" }
    ]);
    // One changing tool is enough for "read and change"; a list made by hand keeps its tools.
    expect(heldDataStores(["data_store.kunden.insert"])).toEqual([
      { store: "kunden", access: "change" }
    ]);
  });

  it("changes one store in its place and leaves every other tool alone", () => {
    const tools = ["web.search", ...READ, "data_store.pruefungen.load", "app.x.y"];
    expect(withDataStoreAccess(tools, "pruefungen", "change")).toEqual([
      "web.search",
      ...CHANGE,
      "data_store.pruefungen.load",
      "app.x.y"
    ]);
    // A verb the section does not set, such as `load`, is not the section's and stays.
    expect(withDataStoreAccess(tools, "pruefungen", undefined)).toEqual([
      "web.search",
      "data_store.pruefungen.load",
      "app.x.y"
    ]);
    expect(isAgentDataStoreToolName("data_store.pruefungen.load")).toBe(false);
    expect(isAgentDataStoreToolName("data_store.pruefungen.delete_rows")).toBe(true);
  });

  it("adds a newly chosen store for reading and keeps the access of those it keeps", () => {
    const tools = ["web.search", ...CHANGE];
    expect(withChosenDataStores(tools, ["pruefungen", "kunden"])).toEqual([
      ...tools,
      "data_store.kunden.describe",
      "data_store.kunden.query",
      "data_store.kunden.preview_rows"
    ]);
    expect(withChosenDataStores(tools, [])).toEqual(["web.search"]);
  });
});

describe("the Daten section of an agent", () => {
  const unmounts: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const unmount of unmounts.splice(0)) await unmount();
  });

  async function render(toolNames: string[], editable = true) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changes: string[][] = [];
    await act(async () => {
      root.render(
        createElement(
          TranslationProvider,
          { locale: "de", children: null },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsDe },
            createElement(AgentDataStores, {
              choice: {
                options: [
                  { name: "pruefungen", title: "Prüfergebnisse" },
                  { name: "kunden", title: "Kunden" }
                ],
                onSearch: () => undefined,
                unusable: [
                  {
                    name: "steuer",
                    title: "Meine Steuer",
                    reason: "Gehört nur dir. Ein Agent für alle kann ihn nicht verwenden."
                  }
                ]
              },
              toolNames,
              editable,
              onChange: (next) => changes.push(next)
            })
          )
        )
      );
    });
    unmounts.push(async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    });
    return { container, changes };
  }

  it("writes the access chosen for a store, and its removal, as the agent's tools", async () => {
    const { container, changes } = await render(["web.search", ...READ]);
    const select = required(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Was der Agent in Prüfergebnisse darf"]'
      )
    );
    expect(select.value).toBe("read");
    await act(async () => {
      select.value = "change";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual(["web.search", ...CHANGE]);
    const remove = required(
      container.querySelector<HTMLButtonElement>('button[aria-label="Prüfergebnisse entfernen"]')
    );
    await act(async () => remove.click());
    expect(changes.at(-1)).toEqual(["web.search"]);
  });

  it("adds a store the agent can use for reading, and never one it cannot", async () => {
    const { container, changes } = await render([]);
    const opener = required(container.querySelector<HTMLElement>('button[aria-label^="Daten"]'));
    await act(async () => opener.click());
    const rows = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
    await vi.waitFor(() => expect(rows()).toHaveLength(3), { timeout: CONDITION_WAIT_MS });
    const greyed = required(rows().find((row) => row.textContent?.startsWith("Meine Steuer")));
    await act(async () => greyed.click());
    expect(changes).toEqual([]);
    const kunden = required(rows().find((row) => row.textContent?.startsWith("Kunden")));
    await act(async () => kunden.click());
    expect(changes.at(-1)).toEqual([
      "data_store.kunden.describe",
      "data_store.kunden.query",
      "data_store.kunden.preview_rows"
    ]);
  });

  it("offers no choice to a reader who may not change the agent", async () => {
    const { container } = await render(CHANGE, false);
    expect(container.querySelector("select")).toBeNull();
  });
});
