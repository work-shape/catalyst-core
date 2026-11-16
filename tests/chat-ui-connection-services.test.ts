import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  CatalogueServices,
  serviceCards,
  type CatalogueEntryOffer,
  type OwnServerEntry,
  type ServiceCard
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// "Dienste" on the Connections page (CAT-PAGE): one card per catalogue entry the reader can act
// on, with what is true of it here. These tests fail where a card set up here would offer a
// second install, where a reader who may make no Connection would be offered one, where an
// entry the operator has not named could be started, or where a person's own server would not
// say that they are connected.

const entry = (id: string, offered = true): CatalogueEntryOffer => ({
  id,
  version: 1,
  service: id,
  title: { en: `Service ${id}`, de: `Dienst ${id}` },
  description: { en: "Reads files.", de: "Liest Dateien." },
  category: "files",
  examplePrompts: [],
  mark: { color: "#2f6f4f" },
  offered,
  parts: [
    {
      part: "tools",
      connectorType: "http_api",
      name: id,
      description: { en: "Agents read.", de: "Agenten lesen." },
      authScheme: "bearer",
      settings: {},
      fields: [],
      prerequisites: [],
      hosts: [],
      sharedAccountNote: { en: "Shared.", de: "Geteilt." },
      documentSource: false,
      operations: []
    }
  ]
});

const notes: OwnServerEntry = {
  id: "notes",
  version: 1,
  service: "notes",
  title: { en: "Notes", de: "Notizen" },
  description: { en: "Your meeting notes.", de: "Deine Besprechungsnotizen." },
  mark: { color: "#123456" },
  url: "https://notes.example.com/mcp",
  signIn: "oauth",
  tools: []
};

const statuses = (cards: readonly ServiceCard[]) =>
  cards.map((card) => [card.id, card.status, card.action?.kind]);

describe("the services on the Connections page", () => {
  it("says of each entry whether it is set up here, connected by the reader, or not yet", () => {
    const cards = serviceCards({
      entries: [entry("ask", false), entry("files"), entry("mail"), entry("crm")],
      ownEntries: [],
      connections: [
        { name: "files-docs", attributes: { catalogueEntry: "files" } },
        { name: "mail", attributes: { catalogueEntry: "mail" } },
        { name: "own-mcp", attributes: {} }
      ],
      mine: [
        // The reader's own account on the personal Connection set up from the mail entry.
        { name: "mail", title: "Mail", state: "connected", catalogue: catalogueOf("mail") }
      ],
      mayCreate: true
    });
    expect(statuses(cards)).toEqual([
      ["files", "set-up", "open"],
      ["mail", "connected", "open"],
      ["crm", "start", "install"],
      // An entry the operator has not named comes last and opens nothing.
      ["ask", "not-offered", undefined]
    ]);
    expect(cards.find((card) => card.id === "files")?.action).toEqual({
      kind: "open",
      name: "files-docs"
    });
  });

  it("offers no install to a reader who may make no Connection, and no sign-in counts that is not", () => {
    const cards = serviceCards({
      entries: [entry("files"), entry("mail")],
      ownEntries: [],
      connections: [{ name: "mail", attributes: { catalogueEntry: "mail" } }],
      mine: [
        { name: "mail", title: "Mail", state: "needs_reconnect", catalogue: catalogueOf("mail") }
      ],
      mayCreate: false
    });
    expect(statuses(cards)).toEqual([["mail", "set-up", "open"]]);
  });

  it("offers a person's own server to add, and says when they added and connected it", () => {
    const fresh = serviceCards({
      entries: [],
      ownEntries: [notes],
      connections: [],
      mine: [],
      mayCreate: false
    });
    expect(statuses(fresh)).toEqual([["notes", "start", "add-own"]]);
    expect(fresh[0]?.parts).toEqual(["own"]);

    const row = {
      name: "notes-a1b2c3",
      title: "Notes",
      service: "notes",
      state: "connected" as const,
      ownServer: { host: "notes.example.com", enabled: true, tools: 2 }
    };
    expect(
      statuses(
        serviceCards({
          entries: [],
          ownEntries: [notes],
          connections: [],
          mine: [row],
          mayCreate: false
        })
      )
    ).toEqual([["notes", "connected", "own-servers"]]);
    expect(
      statuses(
        serviceCards({
          entries: [],
          ownEntries: [notes],
          connections: [],
          mine: [{ ...row, state: "needs_reconnect" }],
          mayCreate: false
        })
      )
    ).toEqual([["notes", "set-up", "own-servers"]]);
    // A server of the same service moved to another host is no longer that entry.
    expect(
      statuses(
        serviceCards({
          entries: [],
          ownEntries: [notes],
          connections: [],
          mine: [{ ...row, ownServer: { ...row.ownServer, host: "elsewhere.example.com" } }],
          mayCreate: false
        })
      )
    ).toEqual([["notes", "start", "add-own"]]);
  });

  it("shows one card for an entry that is both an admin's and a person's own, at its furthest", () => {
    const cards = serviceCards({
      entries: [entry("notes")],
      ownEntries: [notes],
      connections: [],
      mine: [
        {
          name: "notes-a1b2c3",
          title: "Notes",
          service: "notes",
          state: "connected",
          ownServer: { host: "notes.example.com", enabled: true, tools: 2 }
        }
      ],
      mayCreate: true
    });
    expect(statuses(cards)).toEqual([["notes", "connected", "own-servers"]]);
    // The admin's words and parts stay.
    expect(cards[0]?.parts).toEqual(["tools"]);
  });

  it("draws each status in plain words, with a button only where the click starts something", () => {
    const cards = serviceCards({
      entries: [entry("ask", false), entry("files"), entry("crm")],
      ownEntries: [notes],
      connections: [{ name: "files-docs", attributes: { catalogueEntry: "files" } }],
      mine: [],
      mayCreate: true
    });
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "de",
        children: createElement(CatalogueServices, {
          cards,
          hrefOf: (action) =>
            action.kind === "open" ? `/build/connections/${action.name}` : undefined,
          onAct() {}
        })
      })
    );
    expect(markup).toContain("Dienste");
    expect(markup).toContain("Eingerichtet");
    expect(markup).toContain('href="/build/connections/files-docs"');
    expect(markup).toContain("Einrichten");
    expect(markup).toContain("Nur für dich");
    expect(markup).toContain("Frag das technische Team");
    const card = (id: string) => {
      const start = markup.indexOf(`data-catalogue-entry="${id}"`);
      return markup.slice(start, markup.indexOf("</li>", start));
    };
    expect(card("crm")).toContain("data-catalogue-start");
    expect(card("notes")).toContain("data-catalogue-start");
    expect(card("files")).not.toContain("<button");
    expect(card("ask")).not.toContain("<button");
    expect(card("ask")).not.toContain("<a");
    expect(card("ask")).toContain('aria-disabled="true"');
    // No id, no protocol: a card reads as the service it is.
    expect(markup).not.toMatch(/mcp|http_api/i);
  });
});

function catalogueOf(id: string) {
  return { entry: id, part: "tools" as const, version: 1 };
}
