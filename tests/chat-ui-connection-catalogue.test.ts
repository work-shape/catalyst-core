import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  CatalogueInstall,
  CatalogueServices,
  ConnectionCreateFlow,
  catalogueLink,
  entriesToShow,
  partCandidates,
  partDefaults,
  partOffer,
  readingNames,
  recommendedNames,
  selectedCandidates,
  typedConnectionConfig,
  typesWithEntries,
  withApprovedOperations,
  type CatalogueEntryOffer,
  type ConnectionSource,
  type ConnectorTypeOffer
} from "@work-shape/catalyst-chat-ui/build-area";
import { required } from "./support/assertions";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The catalogue in New connection (CAT-1): the "Dienste" group, the part installed through the
// form of its type, and the review of what the entry proposes. An entry only recommends: these
// tests fail where its install would enable an operation, where a changing operation would be
// ticked in advance, or where an entry the operator has not named could be chosen.

/** A Connector type with a form of its own, which the entry `files` installs through. */
const folderType: ConnectorTypeOffer = {
  type: "folder_store",
  title: { en: "Folder store", de: "Ordnerablage" },
  description: { en: "Syncs shared folders.", de: "Synchronisiert geteilte Ordner." },
  service: "folder-store",
  documentSource: true,
  authScheme: "client_credentials",
  settings: {},
  fields: [{ label: { en: "Secret", de: "Secret" }, optional: false, secret: true }]
};

const ledger: CatalogueEntryOffer = {
  id: "ledger",
  version: 3,
  service: "ledger",
  title: { en: "Ledger", de: "Hauptbuch" },
  description: { en: "The books of the firm.", de: "Die Bücher der Kanzlei." },
  category: "accounting",
  examplePrompts: [{ en: "Which clients booked in May?", de: "Wer hat im Mai gebucht?" }],
  mark: { color: "#2f6f4f" },
  offered: true,
  parts: [
    {
      part: "tools",
      connectorType: "http_api",
      name: "ledger",
      description: { en: "Agents read the books.", de: "Agenten lesen die Bücher." },
      authScheme: "bearer",
      settings: { testPath: "/health" },
      fields: [
        {
          label: { en: "Address", de: "Adresse" },
          optional: false,
          setting: "baseUrl",
          secret: false,
          default: "https://ledger.example.test/api"
        },
        { label: { en: "Key", de: "Schlüssel" }, optional: false, secret: true }
      ],
      prerequisites: [
        {
          text: { en: "Open port 443 outbound.", de: "Öffne Port 443 nach außen." },
          value: "ledger.example.test:443"
        }
      ],
      hosts: ["ledger.example.test"],
      sharedAccountNote: {
        en: "The key is the firm's, not a person's.",
        de: "Der Schlüssel gehört der Kanzlei, nicht einer Person."
      },
      documentSource: false,
      operations: [
        {
          name: "listClients",
          effect: "reading",
          recommended: true,
          declaration: {
            title: "List clients",
            description: "Lists the clients.",
            method: "GET",
            path: "/clients"
          }
        },
        {
          name: "listPostings",
          effect: "reading",
          recommended: false,
          declaration: { description: "Lists postings.", method: "GET", path: "/postings" }
        },
        // A changing operation an offer marks as recommended, as a forged answer could.
        { name: "bookPosting", effect: "changing", recommended: true, declaration: {} }
      ]
    }
  ]
};

const files: CatalogueEntryOffer = {
  ...ledger,
  id: "files",
  service: "files",
  title: { en: "Files", de: "Dateien" },
  offered: false,
  parts: [
    {
      ...required(ledger.parts[0]),
      part: "source",
      connectorType: "folder_store",
      name: "files",
      documentSource: true,
      operations: []
    }
  ]
};

describe("the catalogue model", () => {
  it("ticks only the reading operations the entry recommends", () => {
    const part = required(ledger.parts[0]);
    const candidates = partCandidates(part);
    expect(candidates.map((candidate) => [candidate.name, candidate.recommended])).toEqual([
      ["listClients", true],
      ["listPostings", false],
      ["bookPosting", false]
    ]);
    expect(recommendedNames(part)).toEqual(["listClients"]);
    expect(readingNames(candidates)).toEqual(["listClients"]);
  });

  it("installs a Connection with no operation, and enables only what the admin approves", () => {
    const part = required(ledger.parts[0]);
    const offer = partOffer(ledger, part);
    const config = {
      ...typedConnectionConfig(
        offer,
        { name: "ledger", title: "Ledger", description: "" },
        { ...partDefaults(part), 1: "a-key-never-written" }
      ),
      catalogue: catalogueLink(ledger, "tools")
    };
    expect(config).toMatchObject({
      service: "ledger",
      connectorType: "http_api",
      settings: { testPath: "/health", baseUrl: "https://ledger.example.test/api" },
      catalogue: { entry: "ledger", part: "tools", version: 3 },
      operations: []
    });
    expect(JSON.stringify(config)).not.toContain("a-key-never-written");
    expect(partDefaults(part)).toEqual({ 0: "https://ledger.example.test/api" });

    const candidates = partCandidates(part);
    const approved = withApprovedOperations(
      config,
      selectedCandidates(candidates, new Set(recommendedNames(part))),
      ["agent"]
    );
    expect(approved.operations).toEqual([
      {
        title: "List clients",
        description: "Lists the clients.",
        method: "GET",
        path: "/clients",
        name: "listClients",
        effect: "reading",
        exposure: ["agent"],
        enabled: true
      }
    ]);
  });

  it("stands in for the type of an offered entry only, offered entries first", () => {
    expect([...typesWithEntries([ledger, files])]).toEqual(["http_api"]);
    expect(entriesToShow([files, ledger]).map((entry) => entry.id)).toEqual(["ledger", "files"]);
    expect(entriesToShow([{ ...ledger, parts: [] }])).toEqual([]);
  });
});

describe("Dienste in New connection", () => {
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () => connectionDetail(),
    test: async () => ({ status: "ready", testedAt: "2026-10-21T10:00:00.000Z" }),
    setSecret: async () => undefined,
    discover: async () => undefined,
    useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
    useHolders: () => ({ status: "hidden" }),
    principalHref: () => "",
    oauthStart: async () => {
      throw new Error("This test signs nothing in.");
    },
    useConnectorTypes: () => [folderType],
    useCatalogueEntries: () => [files, ledger]
  };
  const props = {
    checkName: async () => ({ available: true as const }),
    put: async () => ({ revision: 1 }),
    onClose: () => undefined,
    onCreated: () => undefined
  };
  const inGerman = (node: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(TranslationProvider, { children: node, locale: "de" }));

  const dialog = (connections: ConnectionSource) =>
    inGerman(
      createElement(ConnectionCreateFlow, {
        ...props,
        source: connections,
        remove: async () => undefined,
        mayDelete: () => true
      })
    );

  it("shows the offered entry to choose and the other one greyed, with no way to choose it", () => {
    const markup = dialog(source);
    expect(markup).toContain("Dienste");
    expect(markup).toContain("Eigene Verbindung");
    expect(markup.indexOf('data-catalogue-entry="ledger"')).toBeLessThan(
      markup.indexOf('data-catalogue-entry="files"')
    );
    // An own MCP server or REST API stays; a type keeps its card while its entry is not named.
    expect(markup).toContain('data-connection-type="http_api"');
    expect(markup).toContain('data-connection-type="folder_store"');
    // Named, the entry stands in for the card of the type it installs through.
    const named = dialog({
      ...source,
      useCatalogueEntries: () => [{ ...files, offered: true }, ledger]
    });
    expect(named).not.toContain('data-connection-type="folder_store"');
    expect(named).toContain('data-catalogue-entry="files"');
    const services = inGerman(
      createElement(CatalogueServices, { entries: [files], onChoose() {} })
    );
    expect(services).toContain('data-catalogue-offered="false"');
    expect(services).toContain("Frag deinen Betreiber");
    expect(services).not.toContain("<button");
  });

  it("prepares the part with its checklist, and says whose account it is before the key", () => {
    const markup = inGerman(
      createElement(CatalogueInstall, {
        ...props,
        entry: ledger,
        source,
        onBack: () => undefined
      })
    );
    expect(markup).toContain("Hauptbuch");
    expect(markup).toContain("Agenten lesen die Bücher.");
    expect(markup).toContain("Erreicht ledger.example.test.");
    expect(markup).toContain("Wer hat im Mai gebucht?");
    expect(markup).toContain("ledger.example.test:443");
    expect(markup).toContain('value="https://ledger.example.test/api"');
    const note = markup.indexOf("data-catalogue-shared-note");
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(markup.indexOf('data-connection-field="secret"'));
  });
});
