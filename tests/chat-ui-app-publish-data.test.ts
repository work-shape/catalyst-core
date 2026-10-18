import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  appManifestSummary,
  appPublishDataRead,
  appReadsStoredData,
  AppStoredDataFact,
  PublishDialog,
  type AppPublishDataRead
} from "@work-shape/catalyst-chat-ui/apps";
import {
  appPublishData,
  DataStoreReaders,
  type AppDataSources,
  type DataStoreSource,
  type DataStoreUsedBy
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// DS-13b in the interface: who would see which stored data when one revision of an App is
// published, and the plain fact behind it, on the App's draft page, in its Publish dialog and
// on the page of the store it reads. The Inbox item of a held publish is in
// `chat-ui-publish-approval.test.ts`.

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const translate = (locale: "en" | "de") => createTranslationContext(locale);

const readingConfig = {
  manifest: { actions: [{ name: "list", kind: "sql", dataStore: "kunden", effect: "reading" }] }
};

const sources: AppDataSources = {
  stores: [
    {
      name: "kunden",
      title: "Kunden",
      fillers: [
        { kind: "workflow", name: "nachtimport", title: "Nachtimport", connections: ["Exampledata"] }
      ],
      actions: ["list", "by_month"],
      rows: { estimate: 312, tables: 1, measuredAt: "2026-10-18T03:00:00Z" }
    },
    { name: "termine", title: "Termine", fillers: [], actions: ["upcoming"] }
  ],
  revision: 4,
  audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: [], hiddenHolders: 2 },
  truncated: false
};

describe("the lines on stored data of a revision to publish", () => {
  it("names who sees which store, by its actions and by what bounds the rows, never as rows they select", () => {
    expect(appPublishData(sources, 4, translate("en").t, "en")).toEqual({
      // The workspace counts people; the holders by a grant are a number of holders.
      audience: "Everyone in Kai Spezis (14 people) · 2 more with access",
      // They hold it by a grant, whoever the App is published for (SHARE-1).
      holders: "2 with access",
      stores: [
        {
          name: "kunden",
          title: "Kunden",
          actions: "2 actions read from it: list and by_month.",
          rows: "What they show depends on their inputs. The whole store held about 312 rows in 1 table when last measured.",
          sources: [
            "Shows data from “Kunden”, which the Workflow “Nachtimport” copies from Exampledata."
          ]
        },
        {
          name: "termine",
          title: "Termine",
          actions: "The action upcoming reads from it.",
          rows: "What they show depends on their inputs. The store has not been measured yet.",
          sources: []
        }
      ],
      truncated: false
    });
    expect(appPublishData(sources, 4, translate("de").t, "de")?.stores[0]).toMatchObject({
      actions: "2 Aktionen lesen daraus: list und by_month.",
      rows: "Was sie zeigen, hängt von ihren Eingaben ab. Der ganze Speicher hatte bei der letzten Messung etwa 312 Zeilen in 1 Tabelle."
    });
    // A store the App may not reach is named as the revision declares it, and said to be so.
    const unavailable: AppDataSources = {
      ...sources,
      stores: [{ name: "lohn", title: "lohn", unavailable: true, fillers: [], actions: ["peek"] }]
    };
    expect(appPublishData(unavailable, 4, translate("en").t, "en")?.stores).toEqual([
      {
        name: "lohn",
        title: "lohn",
        actions: "The action peek reads from it.",
        rows: "No data store of this name is available to the app, so it cannot be published as it is.",
        sources: []
      }
    ]);
  });

  it("takes an answer without an audience, or of another revision, as a failure to retry and not as lines", () => {
    const { t } = translate("en");
    let retried = 0;
    const read = (data: AppDataSources | undefined, failed = false): AppPublishDataRead =>
      appPublishDataRead({ data, failed, retry: () => (retried += 1) }, 4, t, "en");

    expect(read(sources)).toMatchObject({ status: "ready" });
    // The live revision's answer for a question about revision 4.
    const otherRevision = read({ ...sources, revision: 3 });
    expect(otherRevision.status).toBe("failed");
    // An answer asked without a revision names no audience.
    const { audience: _audience, revision: _revision, ...published } = sources;
    expect(read(published).status).toBe("failed");
    expect(read({ ...sources, audience: undefined }).status).toBe("failed");
    expect(read(undefined)).toEqual({ status: "loading" });
    expect(read(undefined, true).status).toBe("failed");
    if (otherRevision.status === "failed") otherRevision.retry();
    expect(retried).toBe(1);
  });
});

describe("the Publish dialog of an App that reads stored data", () => {
  const workspace = { id: "cw_1", name: "Nordlicht Beratung", emoji: null };
  const dialog = (storedData: AppPublishDataRead, locale: "en" | "de" = "en") =>
    render(
      createElement(PublishDialog, {
        name: "Angebotsrechner",
        workspace,
        ask: { revision: 4, summary: appManifestSummary(readingConfig), readsStoredData: true },
        loading: false,
        error: undefined,
        storedData,
        onConfirm() {},
        onClose() {}
      }),
      locale
    );
  const publishButton = (markup: string) =>
    /<button[^>]*>(?:Publish|Veröffentlichen)<\/button>/u.exec(markup)?.[0];
  const answered = (data: AppDataSources, locale: "en" | "de" = "en") =>
    appPublishDataRead({ data, failed: false, retry() {} }, 4, translate(locale).t, locale);

  it("names who sees which stored data and how it is read, and lets Publish go once it does", () => {
    const ready = dialog(answered({ ...sources, truncated: true }));
    expect(ready).toMatch(
      /data-field="data-audience".*Who sees its stored data.*Everyone in Kai Spezis \(14 people\) · 2 more with access/u
    );
    expect(ready).toMatch(/data-data-store="kunden".*Kunden.*2 actions read from it/u);
    expect(ready).toContain("about 312 rows in 1 table when last measured");
    expect(ready).toContain("which the Workflow “Nachtimport” copies from Exampledata.");
    // The fact: the store's own app role, its rights checked for the publisher, not each viewer.
    expect(ready).toContain(
      "These actions read with the data store&#x27;s own app role. Rights on the store are checked for whoever publishes the app, not for each viewer"
    );
    expect(ready).toContain("these lists may be incomplete");
    expect(publishButton(ready)).not.toMatch(/ disabled=""/u);

    const german = dialog(answered(sources, "de"), "de");
    expect(german).toContain(
      "Diese Aktionen lesen mit der eigenen App-Rolle des Datenspeichers. Rechte am Speicher werden bei der Person geprüft, die die App veröffentlicht, nicht bei jeder Person, die sie ansieht."
    );
  });

  it("holds Publish while the lines load, after they failed, and on an answer that does not describe this revision", () => {
    expect(publishButton(dialog({ status: "loading" }))).toMatch(/ disabled=""/u);
    for (const malformed of [
      { ...sources, revision: 3 },
      { ...sources, audience: undefined },
      { stores: sources.stores, truncated: false }
    ]) {
      const markup = dialog(answered(malformed));
      expect(markup).toContain("Who sees its stored data could not be loaded.");
      expect(markup).toContain(">Try again</button>");
      expect(publishButton(markup)).toMatch(/ disabled=""/u);
    }
  });
});

describe("the fact on the draft page of an App", () => {
  it("says on the draft page that a reading statement uses the store's own role, checked for the publisher", () => {
    expect(appReadsStoredData(readingConfig)).toBe(true);
    const english = render(createElement(AppStoredDataFact, { config: readingConfig }));
    expect(english).toContain('data-testid="app-stored-data-fact"');
    expect(english).toContain(
      "When published, this app reads stored data with the data store&#x27;s own app role. Rights on the store are then checked for whoever publishes the app, not for each viewer, so everyone who may use it sees what its actions select."
    );
    expect(render(createElement(AppStoredDataFact, { config: readingConfig }), "de")).toContain(
      "Nach dem Veröffentlichen liest diese App gespeicherte Daten mit der eigenen App-Rolle des Datenspeichers."
    );
    // A changing statement alone shows nobody anything; a draft without one says nothing.
    const changing = {
      manifest: {
        actions: [{ name: "add", kind: "sql", dataStore: "kunden", effect: "changing" }]
      }
    };
    expect(appReadsStoredData(changing)).toBe(false);
    expect(render(createElement(AppStoredDataFact, { config: changing }))).toBe("");
    expect(render(createElement(AppStoredDataFact, { config: undefined }))).toBe("");
  });
});

describe("the readers of a store", () => {
  const usedBy = (apps: DataStoreUsedBy["apps"]): DataStoreUsedBy => ({
    apps,
    workflows: [],
    knowledgeBases: [],
    readers: { holders: [], hiddenHolders: 0 },
    hidden: { apps: 0, workflows: 0, knowledgeBases: 0, fills: 0, reads: 0 },
    truncated: false
  });
  const source = (used: DataStoreUsedBy): DataStoreSource => ({
    useStoreState: () => ({ status: "loading" }),
    useSchema: () => ({ status: "loading" }),
    useListed: () => ({ status: "loading" }),
    useRowsPage: () => ({ status: "loading" }),
    useValue: () => ({ status: "loading" }),
    useUsedBy: () => ({ status: "ready", data: used }),
    useUsingPage: () => () => undefined
  });
  const readers = (used: DataStoreUsedBy, locale: "en" | "de" = "en") =>
    render(
      createElement(DataStoreReaders, {
        store: "kunden",
        workspaceId: undefined,
        source: source(used)
      }),
      locale
    );
  const board = {
    id: "asset_board",
    name: "board",
    title: "Visits board",
    reads: true,
    writes: false,
    sources: [],
    audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: [], hiddenHolders: 0 }
  };

  it("says beside each App that reads the store how it reads, and says nothing where no App reads", () => {
    const markup = readers(usedBy([board]));
    expect(markup).toMatch(/data-data-store-used-by="app".*Visits board.*Everyone in Kai Spezis/u);
    expect(markup).toMatch(
      /data-data-store-apps-fact="">Apps read with this store&#x27;s own app role\. Rights on the store are checked for whoever publishes each app, not for each viewer/u
    );
    expect(readers(usedBy([board]), "de")).toContain(
      "Apps lesen mit der eigenen App-Rolle dieses Speichers."
    );
    expect(readers(usedBy([]))).not.toContain("data-data-store-apps-fact");
    // An App that only adds rows reads nothing.
    expect(readers(usedBy([{ ...board, reads: false, writes: true }]))).not.toContain(
      "data-data-store-apps-fact"
    );
  });
});
