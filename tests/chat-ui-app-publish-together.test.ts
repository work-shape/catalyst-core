import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  AppEditFrame,
  appManifestSummary,
  appPublishCall,
  appPublishConfirmationReady,
  appPublishConfirmationTogether,
  AppPublishConfirmationView,
  appPublishDataRead,
  appPublishTogetherNamed,
  appReadsStoredData,
  AppStoredDataFact,
  appWorkspaceName,
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
import type { PublishNarrativeRead } from "./support/chat-ui";
import { createTranslationContext } from "./support/chat-ui/shared";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Publish question of an App: what it makes live with the App (DP-3, GOLIVE-1), who would
// see which stored data (DS-13b), and how it names the workspace (ACCEPT-FIX-2 C5).

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;
const at = (markup: string, text: string) => {
  const index = markup.indexOf(text);
  expect(index, `${text} is in the markup`).toBeGreaterThan(-1);
  return index;
};
const publishButton = (markup: string) =>
  markup.match(/<button[^>]*>(?:(?!<\/button>).)*(?:Publish|Veröffentlichen)<\/button>/u)?.[0] ??
  "";
const held = (markup: string) => / disabled=""/u.test(publishButton(markup));

type Together = NonNullable<Parameters<typeof PublishDialog>[0]["together"]>;
type Workflow = Together["workflows"][number];
type Store = Together["dataStores"][number];

const child: Workflow = {
  name: "visit-check",
  title: "Visit check",
  draftRevision: 3,
  publishedRevision: 2,
  pending: true,
  lastChangedBy: "Lena Builder",
  lastTestRun: { runId: "wfr_1", status: "done", at: "2026-10-21T08:00:00.000Z" },
  refusals: [],
  actions: []
};
const parent: Workflow = {
  name: "visit-log",
  title: "Visit log",
  draftRevision: 1,
  pending: true,
  lastChangedBy: "Kai Member",
  refusals: [],
  actions: ["log-visit"]
};
const store: Store = {
  name: "pruefergebnisse",
  title: "Prüfergebnisse",
  draftRevision: 3,
  publishedRevision: 2,
  pending: true,
  liveLevel: 1,
  minSchema: 2,
  pendingMigrations: ["add_status"],
  refusals: []
};
/** A store an earlier Publish made live, still applying its migrations. */
const updating: Store = {
  ...store,
  name: "kunden",
  title: "Kunden",
  publishedRevision: 3,
  pending: false
};

const dialog = (together: Together) =>
  render(
    createElement(PublishDialog, {
      name: "Visits",
      workspace: { id: "cw_1", name: "Sales", emoji: null },
      ask: {
        revision: 4,
        live: 3,
        summary: appManifestSummary({ manifest: {} }),
        readsStoredData: false
      },
      loading: false,
      error: undefined,
      together,
      onConfirm: noop,
      onClose: noop
    })
  );
const ready = (workflows: Workflow[], dataStores: Store[] = []): Together => ({
  status: "ready",
  workflows,
  dataStores,
  retry: noop
});

describe("DP-3, GOLIVE-1: the App's Publish question names what it makes live with the App", () => {
  it("lists each pending Workflow, children first, then the stores, and lets Publish go", () => {
    const markup = dialog(ready([child, parent], [store]));
    expect(at(markup, "Workflow “Visit log”")).toBeGreaterThan(
      at(markup, "Workflow “Visit check”")
    );
    expect(at(markup, "Data store “Prüfergebnisse”")).toBeGreaterThan(
      at(markup, "Workflow “Visit log”")
    );
    expect(held(markup)).toBe(false);
    const none = dialog(ready([]));
    expect(none).not.toContain("Published with it");
    expect(held(none)).toBe(false);
  });

  it("holds Publish while they load, after their read failed, and while one would be refused", () => {
    expect(held(dialog({ status: "loading", workflows: [], dataStores: [], retry: noop }))).toBe(
      true
    );
    const failed = dialog({ status: "failed", workflows: [], dataStores: [], retry: noop });
    expect(failed).toContain("Try again");
    expect(held(failed)).toBe(true);
    const noGrant = {
      reason: "no_grant",
      right: "workflow.publish",
      message: "You may not publish the Workflow 'visit-log'."
    };
    expect(held(dialog(ready([{ ...parent, refusals: [noGrant] }])))).toBe(true);
    const below = {
      reason: "data_store_draft_below_min_schema",
      message: "The App needs the Data Store 'pruefergebnisse' at migration level 3."
    };
    expect(held(dialog(ready([], [{ ...store, refusals: [below] }])))).toBe(true);
  });

  it("keeps a store refusal it does not know as sent, and links nowhere without a host", () => {
    const markup = dialog(
      ready(
        [],
        [
          {
            ...store,
            refusals: [
              { reason: "store_reason_from_later", message: "A sentence of a later instance." }
            ]
          }
        ]
      )
    );
    expect(markup).toContain("A sentence of a later instance.");
    expect(markup).not.toContain("Open data store");
    expect(held(markup)).toBe(true);
  });

  it("sends each pending store and Workflow with the revision shown, and no store already live", () => {
    expect(held(dialog(ready([], [updating])))).toBe(false);
    expect(appPublishTogetherNamed(ready([parent], [updating, store]))).toEqual({
      workflows: [{ name: "visit-log", revision: 1 }],
      dataStores: [{ name: "pruefergebnisse", revision: 3 }]
    });
  });

  it("reads the stores an agent's publish names, for its confirmation", () => {
    expect(
      appPublishCall({
        operationId: "assets.publish",
        inputPreview: {
          kind: "app",
          name: "visits",
          revision: 4,
          dataStores: [{ name: "pruefergebnisse", revision: 3 }]
        }
      })
    ).toMatchObject({ workflows: [], dataStores: ["pruefergebnisse"] });
  });
});

describe("GOLIVE-1: the agent's App publish confirmation", () => {
  // A store whose draft is not published, which this publish does not name.
  const unrelated: Store = { ...store, name: "notizen", title: "Notizen" };
  const call = (dataStores: string[] = [], workflows: string[] = []) => ({
    dataStores,
    workflows
  });
  const allowed = (together: Together) =>
    appPublishConfirmationReady({
      offer: { selected: "workspace", choices: ["workspace"], label: "Everyone in Sales" },
      selected: "workspace",
      narrative: { status: "ready", narrative: { summary: "Visits opens.", warnings: [] } },
      readsStoredData: false,
      storedData: { status: "loading" },
      together
    });

  it("shows a live store still being updated where the agent names no store, and nothing else", () => {
    const together = appPublishConfirmationTogether(call(), ready([parent], [updating, unrelated]));
    expect(together.workflows).toEqual([]);
    expect(together.dataStores.map(({ name }) => name)).toEqual(["kunden"]);
    expect(allowed(together)).toBe(true);
    const none = appPublishConfirmationTogether(call(), ready([parent], [unrelated]));
    expect(none).toMatchObject({ status: "ready", workflows: [], dataStores: [] });
  });

  it("keeps the store and Workflow the agent names, with the revision the review shows", () => {
    const together = appPublishConfirmationTogether(
      call(["pruefergebnisse"], ["visit-log"]),
      ready([child, parent], [store, updating, unrelated])
    );
    expect(together.dataStores.map(({ name }) => name)).toEqual(["pruefergebnisse", "kunden"]);
    expect(appPublishTogetherNamed(together)).toEqual({
      workflows: [{ name: "visit-log", revision: 1 }],
      dataStores: [{ name: "pruefergebnisse", revision: 3 }]
    });
  });

  it("holds Allow while the App's review loads or failed", () => {
    for (const status of ["loading", "failed"] as const) {
      const together = appPublishConfirmationTogether(call(), {
        status,
        workflows: [],
        dataStores: [],
        retry: noop
      });
      expect(allowed(together), status).toBe(false);
    }
  });
});

// ACCEPT-FIX-2 C5: an App's Publish question names its workspace one way, and its head says
// what is published. A Personal Workspace is named after its owner ("Mara's workspace"); the
// name stored on its row, "Personal workspace" in every language, is never shown beside it.
// After a publish the head says "Live: version 1", the publish's number, never a revision's.
describe("ACCEPT-FIX-2 C5: the workspace and version an App's Publish names", () => {
  const STORED = "Personal workspace";
  const ALL = { read: true, write: true, publish: true, delete: true };
  const narrative = (summary: string): PublishNarrativeRead => ({
    status: "ready",
    narrative: { summary, warnings: [] }
  });
  /** What the instance offers a Personal Workspace's App that went live for its workspace. */
  const legacyOffer = {
    selected: "self" as const,
    choices: ["self", "instance"] as const,
    label: "Nur für mich",
    live: { audience: "workspace" as const, label: `Alle in ${STORED}` },
    workspaceName: STORED
  };

  it("names the workspace after its owner in the dialog and the agent's confirmation", () => {
    const markup = render(
      createElement(PublishDialog, {
        name: "Urlaubsanträge",
        workspace: { id: "cw_mara", name: "Maras Arbeitsbereich", emoji: null },
        ask: { revision: 1, live: 1, summary: appManifestSummary({}), readsStoredData: false },
        loading: false,
        error: undefined,
        narrative: narrative("Opens."),
        audience: { offer: legacyOffer, selected: "self", onChange: noop },
        onConfirm: noop,
        onClose: noop
      }),
      "de"
    );
    expect(markup).toContain("Alle in Maras Arbeitsbereich");
    expect(markup).not.toContain(STORED);

    const open = { id: "cw_mara", name: "Maras Arbeitsbereich" };
    expect(appWorkspaceName(undefined, open, STORED)).toBe("Maras Arbeitsbereich");
    expect(appWorkspaceName("cw_mara", open, STORED)).toBe("Maras Arbeitsbereich");
    // Another workspace than the open one is named as the instance names it.
    expect(appWorkspaceName("cw_sales", open, "Sales")).toBe("Sales");
    const card = render(
      createElement(AppPublishConfirmationView, {
        offer: legacyOffer,
        selected: "self",
        workspaceName: appWorkspaceName(undefined, open, STORED),
        narrative: narrative("Opens."),
        storedData: undefined,
        disabled: false,
        onChange: noop
      }),
      "de"
    );
    expect(card).toContain("Alle in Maras Arbeitsbereich");
    expect(card).not.toContain(STORED);
  });

  const head = (
    revisions: { draftRevision: number; publishedRevision?: number },
    draftConfig?: unknown
  ) =>
    render(
      createElement(AppEditFrame, {
        name: "Urlaubsanträge",
        workspace: { id: "cw_mara", name: "Maras Arbeitsbereich" },
        rights: ALL,
        ...revisions,
        ...(revisions.publishedRevision === undefined
          ? {}
          : { liveVersion: { number: 4, publishedAt: "2026-10-26T09:00:00.000Z" } }),
        ...(draftConfig === undefined ? {} : { draftConfig }),
        children: null,
        onBack: noop
      })
    );

  it("says the live version's number in the draft's head, never a revision's", () => {
    const live = head({ draftRevision: 7, publishedRevision: 7 });
    expect(live).toContain('data-asset-status="live"');
    expect(live).toMatch(/data-draft-live="">Live: version 4/u);
    expect(live).not.toMatch(/version 7/u);
    const ahead = head({ draftRevision: 9, publishedRevision: 7 });
    expect(ahead).toContain('data-asset-status="draft"');
    expect(ahead).not.toMatch(/version [79]\b/u);
    expect(head({ draftRevision: 1 })).not.toContain("data-draft-live");
  });

  it("says what publishing does to stored data only while the draft is not yet published", () => {
    const reading = {
      manifest: { actions: [{ name: "list", kind: "sql", dataStore: "kunden", effect: "reading" }] }
    };
    const fact = 'data-testid="app-stored-data-fact"';
    expect(head({ draftRevision: 1 }, reading)).toContain(fact);
    expect(head({ draftRevision: 2, publishedRevision: 1 }, reading)).toContain(fact);
    expect(head({ draftRevision: 1, publishedRevision: 1 }, reading)).not.toContain(fact);
  });
});

// DS-13b: who would see which stored data when one revision of an App is published, and the
// plain fact behind it. The Inbox item of a held publish is in
// `chat-ui-publish-approval.test.ts`.
describe("DS-13b: the stored data of a revision to publish", () => {
  const translate = (locale: "en" | "de") => createTranslationContext(locale).t;
  const readingConfig = {
    manifest: { actions: [{ name: "list", kind: "sql", dataStore: "kunden", effect: "reading" }] }
  };
  const sources: AppDataSources = {
    stores: [
      {
        name: "kunden",
        title: "Kunden",
        fillers: [
          {
            kind: "workflow",
            name: "nachtimport",
            title: "Nachtimport",
            connections: ["Exampledata"]
          }
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
  const answered = (data: AppDataSources) =>
    appPublishDataRead({ data, failed: false, retry() {} }, 4, translate("en"), "en");

  it("names who sees which store, and says of a store the App may not reach that it is so", () => {
    const lines = appPublishData(sources, 4, translate("en"), "en");
    expect(lines?.audience).toContain("Kai Spezis (14 people)");
    expect(lines?.audience).toContain("2 more");
    expect(lines?.stores.map(({ name }) => name)).toEqual(["kunden", "termine"]);
    expect(lines?.stores[0]?.sources).toHaveLength(1);
    const unavailable: AppDataSources = {
      ...sources,
      stores: [{ name: "lohn", title: "lohn", unavailable: true, fillers: [], actions: ["peek"] }]
    };
    expect(appPublishData(unavailable, 4, translate("en"), "en")?.stores[0]?.rows).toContain(
      "cannot be published"
    );
  });

  it("takes an answer without an audience, or of another revision, as a failure to retry", () => {
    let retried = 0;
    const read = (data: AppDataSources | undefined, failed = false): AppPublishDataRead =>
      appPublishDataRead({ data, failed, retry: () => (retried += 1) }, 4, translate("en"), "en");

    expect(read(sources)).toMatchObject({ status: "ready" });
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

  const storedDialog = (storedData: AppPublishDataRead) =>
    render(
      createElement(PublishDialog, {
        name: "Angebotsrechner",
        workspace: { id: "cw_1", name: "Nordlicht Beratung", emoji: null },
        ask: { revision: 4, summary: appManifestSummary(readingConfig), readsStoredData: true },
        loading: false,
        error: undefined,
        storedData,
        onConfirm() {},
        onClose() {}
      })
    );

  it("lets Publish go once the dialog names who sees the stored data, and holds it until then", () => {
    const shown = storedDialog(answered(sources));
    expect(shown).toContain('data-data-store="kunden"');
    expect(held(shown)).toBe(false);
    expect(held(storedDialog({ status: "loading" }))).toBe(true);
    for (const malformed of [
      { ...sources, revision: 3 },
      { ...sources, audience: undefined },
      { stores: sources.stores, truncated: false }
    ]) {
      const markup = storedDialog(answered(malformed));
      expect(markup).toContain(">Try again</button>");
      expect(held(markup)).toBe(true);
    }
  });

  it("states the fact on the draft page only for a draft whose statement reads", () => {
    expect(appReadsStoredData(readingConfig)).toBe(true);
    expect(render(createElement(AppStoredDataFact, { config: readingConfig }))).toContain(
      'data-testid="app-stored-data-fact"'
    );
    // A changing statement alone shows nobody anything; a draft without one says nothing.
    const changing = {
      manifest: { actions: [{ name: "add", kind: "sql", dataStore: "kunden", effect: "changing" }] }
    };
    expect(appReadsStoredData(changing)).toBe(false);
    expect(render(createElement(AppStoredDataFact, { config: changing }))).toBe("");
    expect(render(createElement(AppStoredDataFact, { config: undefined }))).toBe("");
  });

  it("states the fact on a store's page only where an App reads the store", () => {
    const usedBy = (apps: DataStoreUsedBy["apps"]): DataStoreUsedBy => ({
      apps,
      workflows: [],
      knowledgeBases: [],
      readers: { holders: [], hiddenHolders: 0 },
      hidden: { apps: 0, workflows: 0, knowledgeBases: 0, fills: 0, reads: 0 },
      truncated: false
    });
    const source = (used: DataStoreUsedBy): DataStoreSource => ({
      seesServerConditions: false,
      useStoreState: () => ({ status: "loading" }),
      useSchema: () => ({ status: "loading" }),
      useListed: () => ({ status: "loading" }),
      useRowsPage: () => ({ status: "loading" }),
      useValue: () => ({ status: "loading" }),
      useUsedBy: () => ({ status: "ready", data: used }),
      useUsingPage: () => () => undefined,
      review: {
        useFlagged: () => ({ status: "loading" }),
        decide: () => Promise.resolve(undefined)
      },
      testCopy: {
        reset: () => Promise.resolve(undefined),
        remove: () => Promise.resolve(undefined)
      }
    });
    const readers = (used: DataStoreUsedBy) =>
      render(
        createElement(DataStoreReaders, {
          store: "kunden",
          workspaceId: undefined,
          source: source(used)
        })
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
    expect(readers(usedBy([board]))).toContain("data-data-store-apps-fact");
    expect(readers(usedBy([]))).not.toContain("data-data-store-apps-fact");
    // An App that only adds rows reads nothing.
    expect(readers(usedBy([{ ...board, reads: false, writes: true }]))).not.toContain(
      "data-data-store-apps-fact"
    );
  });
});
