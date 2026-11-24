import { createElement, type ReactNode } from "react";
import type { PartState } from "@assistant-ui/react";
import {
  ApiError,
  appInterfacePath,
  type AssetSummary,
  type ConfigAssetPublication,
  type ConfigAssetRevision
} from "@work-shape/catalyst-api-client";
import { describe, expect, it, vi } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  afterPublishSend,
  AppCard,
  AppCardView,
  appCardState,
  appDraftIsAhead,
  appHistory,
  AppEditFrame,
  appLink,
  appManifestSummary,
  appPreviewProblem,
  appPreviewProblemText,
  appDraftShown,
  appRefusalText,
  appsRowShown,
  AppPreviewNotice,
  appPreviewState,
  appRowActions,
  appRowRoute,
  appState,
  AppsHostProvider,
  AppsPageView,
  fileMarks,
  AppViewFrame,
  NO_APP_RIGHTS,
  pageAppChoice,
  previewNeedsApp,
  previewStanding,
  PublishDialog,
  resolveAppRights,
  RevisionsDrawerView,
  SaveAsAppAction,
  SaveAsAppDialogView,
  saveAsAppInput,
  UpdateAppDialogView,
  type AppRights,
  type AppsHost,
  areaOfRoute,
  railSections,
  shownRailSections,
  workspaceRouteFromPath,
  workspaceRouteNavigation,
  workspaceRoutePath
} from "@work-shape/catalyst-chat-ui/apps";
import { appSavedByCall, foldedCards } from "@work-shape/catalyst-chat-ui/subject-run";
import {
  createAssistantMessageGroupBy,
  createCompletedAssistantWorkIndices,
  createVisibleFinalAssistantPartIndices
} from "./support/chat-ui";
import { appsContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Apps area: its addresses, what a reader is offered by the rights they hold, and what
// each screen does with what the instance answers.

const { t } = createTranslationContext("en");

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;

const workspace = { id: "cw_1", name: "Nordlicht Beratung", emoji: null };
const ALL: AppRights = { read: true, write: true, publish: true, delete: true };
const ALL_NAMES = ["app.read", "app.write", "app.publish", "app.delete"];
const WRITER: AppRights = { read: true, write: true, publish: false, delete: false };
const READER: AppRights = { ...NO_APP_RIGHTS, read: true };

function summary(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    id: "asset_1",
    kind: "app",
    name: "angebotsrechner",
    title: "Angebotsrechner",
    description: "Rechnet ein Angebot aus Tagessatz und Tagen.",
    scope: { kind: "workspace", workspaceId: "cw_1" },
    revision: 3,
    draftRevision: 3,
    publishedRevision: 2,
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides
  };
}
const draftOnly = summary({
  name: "urlaubsplaner",
  title: "Urlaubsplaner",
  publishedRevision: undefined,
  revision: 1,
  draftRevision: 1
});

describe("addresses of the Apps area", () => {
  it("builds the address of an App and of its draft with the function the server answers with", () => {
    const address = { workspaceId: "cw_1", app: "angebotsrechner" };
    const route = { collaborationWorkspaceId: "cw_1", app: "angebotsrechner" };

    expect(workspaceRoutePath({ kind: "app", ...route })).toBe(
      appInterfacePath({ ...address, mode: "published" })
    );
    expect(workspaceRoutePath({ kind: "app-edit", ...route })).toBe(
      appInterfacePath({ ...address, mode: "draft" })
    );
    expect(workspaceRouteFromPath(appInterfacePath({ ...address, mode: "draft" }))).toEqual({
      kind: "app-edit",
      ...route
    });
    expect(workspaceRouteFromPath(appInterfacePath({ ...address, mode: "published" }))).toEqual({
      kind: "app",
      ...route
    });
  });

  it("reads the App's own route after its address, and writes it back", () => {
    const route = workspaceRouteFromPath("/w/cw_1/apps/angebotsrechner/kunden/42");

    expect(route).toEqual({
      kind: "app",
      collaborationWorkspaceId: "cw_1",
      app: "angebotsrechner",
      appPath: "/kunden/42"
    });
    expect(areaOfRoute(route)).toBe("apps");
    expect(workspaceRoutePath(route)).toBe("/w/cw_1/apps/angebotsrechner/kunden/42");
    expect(workspaceRouteNavigation(route)).toEqual({
      to: "/w/$collaborationWorkspaceId/apps/$app/$",
      params: { collaborationWorkspaceId: "cw_1", app: "angebotsrechner", _splat: "kunden/42" }
    });
  });

  it("opens an App on its start without a route, and keeps every route below it the App's own", () => {
    const app = { kind: "app", collaborationWorkspaceId: "cw_1", app: "a" } as const;

    expect(workspaceRoutePath({ ...app, appPath: "/" })).toBe("/w/cw_1/apps/a");
    // The draft stands outside the App's addresses, so an App's own `/edit` is its.
    expect(workspaceRoutePath({ ...app, appPath: "/edit" })).toBe("/w/cw_1/apps/a/edit");
    expect(workspaceRouteFromPath("/w/cw_1/apps/a/edit")).toEqual({ ...app, appPath: "/edit" });
    expect(workspaceRouteFromPath("/w/cw_1/app-drafts/a").kind).toBe("app-edit");
    expect(workspaceRouteFromPath("/w/cw_1/apps/a/edit/more")).toEqual({
      ...app,
      appPath: "/edit/more"
    });
  });

  it("keeps a route with characters an address has to encode", () => {
    const route = {
      kind: "app",
      collaborationWorkspaceId: "cw_1",
      app: "a",
      appPath: "/kunde/Müller & Söhne"
    } as const;
    const path = workspaceRoutePath(route);

    expect(path).toBe("/w/cw_1/apps/a/kunde/M%C3%BCller%20%26%20S%C3%B6hne");
    expect(workspaceRouteFromPath(path)).toEqual(route);
  });

  it("gives a link another person can follow, without a credential in it", () => {
    expect(appLink("cw_1", "angebotsrechner", "https://catalyst.example")).toBe(
      "https://catalyst.example/w/cw_1/apps/angebotsrechner"
    );
  });
});

describe("the Apps row of the rail", () => {
  it("shows with the module on and not without it", () => {
    const ids = (given: Parameters<typeof shownRailSections>[1]) =>
      shownRailSections(railSections, given).map((section) => section.id);

    expect(ids({ apps: true })).toEqual(["apps"]);
    expect(ids({ apps: false })).toEqual([]);
    expect(ids({})).toEqual([]);
    expect(ids({ apps: true, inbox: { toDecide: 0 } })).toEqual(["apps", "inbox"]);
  });

  // NAV-VIS-1: the instance names the row in the workspace's agent list, where its Apps page
  // lists the person an App or they may write one there; the browser only reads the flag.
  it("shows where the instance names it for the open workspace and the module is on", () => {
    expect(appsRowShown(true, { visibleSections: ["agents", "apps"] })).toBe(true);
    expect(appsRowShown(true, { visibleSections: ["agents"] })).toBe(false);
    expect(appsRowShown(false, { visibleSections: ["apps"] })).toBe(false);
    // Until the list arrived, or where it failed, nothing is known to show.
    expect(appsRowShown(true, undefined)).toBe(false);
  });
});

describe("what a reader may do with Apps", () => {
  it("reads the four rights the instance names in the open workspace", () => {
    const context = appsContext({ cw_open: ["app.read", "app.write"], cw_other: ALL_NAMES });
    expect(resolveAppRights(undefined, "cw_open")).toEqual(NO_APP_RIGHTS);
    expect(resolveAppRights(context, undefined)).toEqual(NO_APP_RIGHTS);
    expect(resolveAppRights(context, "cw_open")).toEqual(WRITER);
    expect(resolveAppRights(context, "cw_other")).toEqual(ALL);
    // A right on the instance's own assets is not one in a workspace the instance does not name.
    expect(resolveAppRights(appsContext({}, ALL_NAMES), "cw_open")).toEqual(NO_APP_RIGHTS);
  });

  it("tells a published App with a draft ahead from one that has only a draft", () => {
    expect(appState(summary())).toEqual({ kind: "published", revision: 2, draftAhead: true });
    expect(appState(summary({ draftRevision: 2, revision: 2 }))).toEqual({
      kind: "published",
      revision: 2,
      draftAhead: false
    });
    expect(appState(summary({ publishedRevision: undefined }))).toEqual({ kind: "draft_only" });
    // The published view names no draft: nothing is ahead for a reader who is shown it.
    const publishedView = summary({ revision: 2, draftRevision: undefined, publishedRevision: 2 });
    expect(appDraftShown(publishedView)).toBe(false);
    expect(appDraftShown(summary())).toBe(true);
    expect(appState(publishedView)).toEqual({ kind: "published", revision: 2, draftAhead: false });
  });

  it("offers the row actions in their order, and leaves out what the reader may not do", () => {
    const published = appState(summary());
    const unpublished = appState(summary({ publishedRevision: undefined }));

    expect(appRowActions(ALL, published, true)).toEqual([
      "open",
      "edit",
      "rename",
      "details",
      "copy_link",
      "delete"
    ]);
    expect(appRowActions(WRITER, published, true)).toEqual([
      "open",
      "edit",
      "rename",
      "details",
      "copy_link"
    ]);
    // A writer who was shown the published view alone has no draft to edit, and still renames:
    // the name is the App's, not its draft's.
    expect(appRowActions(WRITER, published, false)).toEqual([
      "open",
      "rename",
      "details",
      "copy_link"
    ]);
    expect(appRowActions(NO_APP_RIGHTS, published, false)).toEqual(["open", "copy_link"]);
    // Nothing is served yet: there is nothing to open and no address to hand on.
    expect(appRowActions(ALL, unpublished, true)).toEqual(["edit", "rename", "details", "delete"]);
  });

  it("leads a row to the App, or to the draft for a writer while nothing is published", () => {
    const address = { collaborationWorkspaceId: "cw_1", app: "angebotsrechner" };
    const unpublished = appState(summary({ publishedRevision: undefined }));

    expect(appRowRoute("cw_1", summary(), appState(summary()), NO_APP_RIGHTS)).toEqual({
      kind: "app",
      ...address
    });
    expect(appRowRoute("cw_1", summary(), unpublished, WRITER)).toEqual({
      kind: "app-edit",
      ...address
    });
    expect(appRowRoute("cw_1", summary(), unpublished, READER)).toBe(undefined);
  });
});

describe("the Apps page", () => {
  const now = new Date("2026-10-11T12:00:00.000Z");
  /** `building`: an agent here builds Apps, so the host can start one with it. */
  const page = (
    rows: readonly AssetSummary[] | undefined,
    rights: AppRights,
    extra = {},
    building = true
  ) =>
    render(
      createElement(AppsPageView, {
        workspace,
        rights,
        list: {
          rows,
          failed: false,
          hasMore: false,
          loadingMore: false,
          loadMore() {},
          retry() {},
          ...extra
        },
        now,
        onOpenRoute() {},
        onAction() {},
        ...(building ? { onNew() {} } : {})
      })
    );
  const cards = (markup: string) => markup.split("<li").slice(1);

  it("offers New app to a reader who may build one, with an agent that builds it", () => {
    expect(page([summary()], ALL)).toContain("New app");
    expect(page(undefined, ALL)).toContain("New app");
    expect(page([summary()], READER)).not.toContain("New app");
    expect(page([summary()], ALL, {}, false)).not.toContain("New app");
  });

  it("gives a builder the draft beside the App, and whoever uses Apps only what is published", () => {
    const [published, draft] = cards(page([summary(), draftOnly], ALL));
    expect(published).toContain('href="/w/cw_1/apps/angebotsrechner"');
    expect(published).toContain('href="/w/cw_1/app-drafts/angebotsrechner"');
    expect(published).toContain("Draft: changed");
    expect(draft).toContain('href="/w/cw_1/app-drafts/urlaubsplaner"');

    const [usedPublished, usedDraft] = cards(page([summary(), draftOnly], NO_APP_RIGHTS));
    expect(usedPublished).toContain('href="/w/cw_1/apps/angebotsrechner"');
    expect(usedPublished).not.toContain("app-drafts");
    expect(usedPublished).not.toContain("Draft: changed");
    expect(usedPublished).not.toContain("Published");
    // Nothing is published of the second one: its card says so and opens nothing.
    expect(usedDraft).toContain("Draft · not published");
    expect(usedDraft).not.toContain("<a ");
    expect(usedDraft).not.toContain("<button");
  });

  it("keeps the draft's news from a reader who does not write", () => {
    const markup = page([summary()], { ...NO_APP_RIGHTS, publish: true });
    expect(markup).toContain(">Published<");
    expect(markup).not.toContain("Draft: changed");
    // The right to read the record alone makes nobody a builder.
    expect(page([summary()], READER)).not.toContain("Published");
  });

  it("offers building from an empty list only to a builder with an agent that builds Apps", () => {
    expect(page([], ALL)).toContain(">Build one with the agent</button>");
    expect(page([], ALL)).not.toContain("New app");
    for (const markup of [page([], NO_APP_RIGHTS), page([], ALL, {}, false)]) {
      expect(markup).not.toContain("Build one with the agent");
      expect(markup).not.toContain("<button");
    }
  });

  it("offers the next page while the instance holds more, and the way to ask again", () => {
    expect(page([summary()], ALL, { hasMore: true })).toContain(">Show more</button>");
    expect(page(undefined, ALL, { failed: true })).toContain(">Try again</button>");
  });
});

describe("an open App", () => {
  const frame = (
    rights: AppRights,
    draftShown = true,
    extra: Partial<Parameters<typeof AppViewFrame>[0]> = {}
  ) =>
    render(
      createElement(AppViewFrame, {
        draftShown,
        name: "Angebotsrechner",
        workspace,
        rights,
        publishedRevision: 2,
        liveVersion: { number: 5, publishedAt: "2026-10-26T09:00:00.000Z" },
        children: createElement("p", null, "the app"),
        onBack() {},
        onEdit() {},
        onDetails() {},
        app: "fee-estimate",
        ...extra
      })
    );

  it("offers whoever uses the App its link alone, and a builder its version and details", () => {
    const user = frame(NO_APP_RIGHTS);
    expect(user).not.toContain("Live:");
    expect(user).not.toContain('aria-label="More actions"');
    expect(user).toContain("Copy link");
    expect(frame(WRITER)).toContain('aria-label="More actions"');
    // A publisher is a builder and reads the number, also without the right to write.
    expect(frame({ ...NO_APP_RIGHTS, publish: true })).toContain("Live: version 5");
  });

  it("offers Edit to a writer while a draft is shown, and to nobody else", () => {
    expect(frame(WRITER)).toContain("Edit</span></button>");
    expect(frame(NO_APP_RIGHTS)).not.toContain("Edit</span></button>");
    expect(frame(WRITER, false)).not.toContain("Edit</span></button>");
  });

  it("tells whoever uses the App where its data comes from, and why a scoped read is empty", () => {
    const label = 'aria-label="Where the data comes from"';
    expect(frame(NO_APP_RIGHTS, true, { dataSources: ["Shows data from “Clients”."] })).toContain(
      label
    );
    expect(frame(NO_APP_RIGHTS)).not.toContain(label);
    expect(frame(NO_APP_RIGHTS, true, { dataSources: [] })).not.toContain(label);
    expect(frame(NO_APP_RIGHTS, false, { unassignedScopes: ["Mandant"] })).toContain(
      "No Mandant is assigned to you."
    );
  });
});

describe("the draft of an App", () => {
  const frame = (rights: AppRights, extra: Partial<Parameters<typeof AppEditFrame>[0]> = {}) =>
    render(
      createElement(AppEditFrame, {
        name: "Angebotsrechner",
        workspace,
        rights,
        draftRevision: 3,
        publishedRevision: 2,
        liveVersion: { number: 1, publishedAt: "2026-10-26T09:00:00.000Z" },
        children: createElement("p", null, "the draft"),
        onBack() {},
        ...extra
      })
    );
  const publishButton = (markup: string) =>
    /<button[^>]*>(?:(?!<\/button>).)*Publish<\/button>/u.exec(markup)?.[0] ?? "";

  it("lets Publish go for a publisher, and holds it for a writer with the right it lacks", () => {
    expect(publishButton(frame(ALL))).not.toContain('disabled=""');
    const writer = frame(WRITER);
    expect(publishButton(writer)).toContain('disabled=""');
    expect(writer).toContain("app.publish");
    // A draft that is what is published may still be published for another audience (SHARE-1).
    expect(publishButton(frame(ALL, { draftRevision: 2, publishedRevision: 2 }))).not.toContain(
      'disabled=""'
    );
  });

  it("knows a draft ahead of what is published", () => {
    expect(appDraftIsAhead(3, 2)).toBe(true);
    expect(appDraftIsAhead(2, 2)).toBe(false);
    expect(appDraftIsAhead(1, undefined)).toBe(true);
  });

  it("shows a reader without the write right no action and no draft line", () => {
    const markup = frame(NO_APP_RIGHTS);
    expect(markup).not.toContain("Publish");
    expect(markup).not.toContain("More actions");
    expect(markup).not.toContain("app-draft-line");
    expect(frame(ALL)).toContain("app-draft-line");
  });

  // DT-1b: a Data Store with a test copy is named in the head, with the way to its page.
  it("leads to each test copy the draft writes to, and to where its data comes from", () => {
    const markup = frame(ALL, {
      testCopies: [{ name: "kunden", title: "Kunden" }],
      onOpenRoute: noop,
      dataSources: ["Kunden is filled by the Workflow “Nachtimport”."]
    });
    expect(markup).toMatch(
      /<a[^>]*href="[^"]*\/build\/data-stores\/kunden"[^>]*data-draft-test-target="copy"/u
    );
    expect(markup).toContain('aria-label="Where the data comes from"');
    expect(frame(ALL)).not.toContain("Where the data comes from");
  });

  it("folds Files and Actions under Technical details", () => {
    const tabNames = (detailsOpen: boolean) =>
      [
        ...frame(ALL, {
          view: "preview",
          detailsOpen,
          onViewChange() {},
          onDetailsOpenChange() {}
        }).matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/gu)
      ].map((tab) => tab[1]);
    expect(tabNames(true)).toEqual(["Preview", "Files", "Actions"]);
    expect(tabNames(false)).toEqual(["Preview"]);
  });

  it("says in its own words only the refusals it knows", () => {
    const refused = (reason: string) =>
      new ApiError(422, "As the instance says it", {
        error: { code: "VALIDATION_FAILED", details: { reason } }
      });
    expect(appRefusalText(refused("revision_files_removed"), t)).toBeDefined();
    expect(appRefusalText(refused("input_too_large_to_hold"), t)).toBeDefined();
    expect(appRefusalText(refused("something_else"), t)).toBeUndefined();
    expect(appRefusalText(new Error("offline"), t)).toBeUndefined();
  });
});

describe("the Publish question of an App", () => {
  const ask = (actions: unknown[], externalHosts: string[]) => ({
    revision: 3,
    summary: appManifestSummary({
      manifest: { connections: ["crm"], actions, externalHosts }
    }),
    readsStoredData: false
  });

  it("names the Connections and outside hosts the revision reaches, and marks what it adds", () => {
    const markup = render(
      createElement(PublishDialog, {
        name: "Angebotsrechner",
        workspace,
        ask: ask(
          [{ name: "angebot_speichern", effect: "changing" }],
          ["api.example.com", "maps.example.com"]
        ),
        changes: {
          changing: [
            { label: "angebot_speichern", change: "new" },
            { label: "kunde_anlegen", change: "changed" }
          ],
          hostsAdded: ["maps.example.com"]
        },
        loading: false,
        error: undefined,
        onConfirm() {},
        onClose() {}
      })
    );
    expect(markup).toContain(">crm</code>");
    expect(markup).toMatch(/data-change-item="angebot_speichern"[^]*?>New</u);
    expect(markup).toMatch(/data-change-item="kunde_anlegen"[^]*?>Changed</u);
    expect(markup).toMatch(/data-change-item="maps\.example\.com"[^]*?>New</u);
    // A host live already calls is named without a tag.
    const kept = /data-change-item="api\.example\.com".*?<\/li>/u.exec(markup)?.[0];
    expect(kept).toContain("api.example.com");
    expect(kept).not.toContain("data-change-tag");
  });

  it("reads a manifest nobody vouches for without trusting its shape", () => {
    expect(appManifestSummary(undefined)).toEqual({ connections: [], actions: [], hosts: [] });
    expect(
      appManifestSummary({ manifest: { connections: "crm", actions: [{}, { name: 7 }, "x"] } })
    ).toEqual({ connections: [], actions: [], hosts: [] });
  });

  // DT-1b: the Files tab marks each file against what is live.
  it("marks each file new, changed or removed against what is live", () => {
    const marks = fileMarks(
      [{ path: "a.tsx" }, { path: "b.tsx" }, { path: "c.tsx" }],
      [{ path: "a.tsx" }, { path: "c.tsx" }, { path: "gone.tsx" }],
      new Set(["a.tsx", "b.tsx"])
    );
    expect(Object.fromEntries(marks)).toEqual({
      "a.tsx": "changed",
      "b.tsx": "new",
      "gone.tsx": "removed"
    });
    expect(fileMarks([{ path: "a.tsx" }], undefined, new Set()).size).toBe(0);
  });
});

describe("the history of an App", () => {
  const revision = (number: number, overrides: Partial<ConfigAssetRevision> = {}) =>
    ({
      assetId: "cfga_angebotsrechner",
      revision: number,
      operation: number === 1 ? "create" : "update",
      config: { name: "angebotsrechner", title: "Angebotsrechner", manifest: {} },
      actor: { displayLabel: "Jana Petersen", roles: [] },
      globalVersion: number,
      createdAt: `2026-10-0${number}T09:30:00.000Z`,
      ...overrides
    }) satisfies ConfigAssetRevision;
  const publication = (number: number, published: number, day: number, by?: string) =>
    ({
      number,
      revision: published,
      actor: by ? { displayLabel: by, roles: [] } : null,
      publishedAt: `2026-10-0${day}T12:00:00.000Z`
    }) satisfies ConfigAssetPublication;
  // Five saves and three publishes: revision 1, then 3, then back to 1.
  const publications = [
    publication(3, 1, 4, "Jana Petersen"),
    publication(2, 3, 3, "Jana Petersen"),
    publication(1, 1, 1)
  ];
  const revisions = [revision(5), revision(4), revision(3), revision(2), revision(1)];
  const drawer = (
    shown: { publications: ConfigAssetPublication[]; revisions: ConfigAssetRevision[] },
    extra: Partial<Parameters<typeof RevisionsDrawerView>[0]> = {}
  ) =>
    render(
      createElement(RevisionsDrawerView, {
        open: true,
        name: "Angebotsrechner",
        ...shown,
        failed: false,
        hasMore: false,
        loadingMore: false,
        draftRevision: 5,
        publishedRevision: 1,
        onLoadMore() {},
        onRetry() {},
        onClose() {},
        ...extra
      })
    );

  it("folds the saves under the version each came after, the newest version first", () => {
    // Revisions 1 and 3 are versions: neither is also a draft save. The way back to revision 1
    // is version 3 of its own, and the save that became version 2 is not folded under 1.
    expect(appHistory(publications, revisions, true)).toEqual({
      versions: [
        { publication: publications[0], saves: [revisions[0]] },
        { publication: publications[1], saves: [revisions[1]] },
        { publication: publications[2], saves: [revisions[3]] }
      ],
      before: []
    });
    // A save older than every version read waits for the versions further back.
    expect(appHistory(publications.slice(0, 2), revisions, false).before).toEqual([]);
    expect(appHistory([publication(1, 1, 1)], [revision(1)], true)).toEqual({
      versions: [{ publication: publication(1, 1, 1), saves: [] }],
      before: []
    });
  });

  it("folds under each version only the saves after it, and keeps earlier saves before 1", () => {
    // Saved 1, 2 and 3; published 2 as version 1 and 4 as version 2; saved 5 since.
    const second = [publication(2, 4, 4), publication(1, 2, 2)];
    expect(appHistory(second, revisions, true)).toEqual({
      versions: [
        { publication: second[0], saves: [revisions[0]] },
        { publication: second[1], saves: [revisions[2]] }
      ],
      before: [revisions[4]]
    });
  });

  it("reads a revert as a version of its own, with the saves after it under it", () => {
    // Published 1, then 2, then 1 again; saved 3 since.
    const reverted = [publication(3, 1, 3), publication(2, 2, 2), publication(1, 1, 1)];
    const saves = [revision(4), revision(2), revision(1)];
    const history = appHistory(reverted, saves, true);
    expect(history.versions.map(({ publication: { number } }) => number)).toEqual([3, 2, 1]);
    expect(history.versions.map(({ saves: folded }) => folded)).toEqual([[saves[0]], [], []]);
    expect(history.before).toEqual([]);
  });

  it("marks the live version, and lists no save a version made live as a draft save", () => {
    const markup = drawer({ publications, revisions });
    expect(markup).toMatch(/data-version="3"(?:(?!data-version).)*>Published</u);
    expect(markup).not.toMatch(/data-version="[12]"(?:(?!data-version).)*>Published</u);
    expect(markup).not.toMatch(/data-revision="[13]"/u);
    expect(markup).not.toContain("Publish this save");
  });

  it("lets a holder of the publish right publish every save and version but the live one", () => {
    const markup = drawer({ publications, revisions }, { onPublish: noop });
    expect(markup.match(/Publish this save/gu)).toHaveLength(3);
    // Version 2 may be published again; versions 3 and 1 are the live revision.
    expect(markup.match(/Publish again/gu)).toHaveLength(1);
    expect(markup).toMatch(/data-version="2"(?:(?!data-version).)*Publish again/u);
  });

  it("keeps old agent saves neutral and does not infer chronology from an unknown publish time", () => {
    const unknown = { ...publication(1, 2, 2), publishedAt: undefined };
    const saves = [
      revision(4, { origin: { kind: "agent_run", conversationId: "conv_old" } }),
      revision(3, {
        origin: {
          kind: "page",
          conversationId: "conv_old",
          pageId: "page_1",
          fileSetNumber: 1,
          byAgent: true,
          agentDisplayName: "Page helper"
        }
      }),
      revision(2),
      revision(1)
    ];
    expect(appHistory([unknown], saves, true)).toEqual({
      versions: [{ publication: unknown, saves: [] }],
      before: [saves[0], saves[1], saves[3]]
    });
    const markup = drawer(
      { publications: [unknown], revisions: saves },
      { draftRevision: 4, publishedRevision: 2 }
    );
    expect(markup).toContain("Agent for Jana Petersen");
    expect(markup).toContain("Page helper for Jana Petersen");
    expect(markup).not.toContain("Invalid Date");
    expect(markup).not.toContain("before version 1");
  });

  it("lists the saves of an App never published as they are", () => {
    const markup = drawer(
      { publications: [], revisions: [revision(2), revision(1)] },
      { draftRevision: 2, publishedRevision: undefined }
    );
    expect(markup.match(/data-revision="/gu)).toHaveLength(2);
    expect(markup).not.toContain("Version");
  });
});

describe("the pane of an App that is not shown", () => {
  const refusal = (status: number, reason?: string) =>
    new ApiError(status, "Not available", {
      error: { code: "NOT_FOUND", ...(reason ? { details: { reason } } : {}) }
    });
  const notice = (problem: ReturnType<typeof appPreviewProblem> | undefined, mode = "published") =>
    render(
      createElement(AppPreviewNotice, {
        state: appPreviewState({ shown: false, problem }),
        mode: mode === "draft" ? "draft" : "published",
        name: "Angebotsrechner",
        problem,
        stoppedAction: createElement("button", null, "to the draft"),
        onRetry() {}
      })
    );

  it("reads why the instance gave no address", () => {
    expect(appPreviewProblem(refusal(404, "not_published"))).toBe("not_published");
    expect(appPreviewProblem(refusal(404))).toBe("unavailable");
    expect(appPreviewProblem(refusal(403))).toBe("unavailable");
    expect(appPreviewProblem(refusal(404, "kit_unavailable"))).toBe("kit_unavailable");
    expect(appPreviewProblem(refusal(404, "file_set_unknown"))).toBe("file_set_unknown");
    expect(appPreviewProblem(refusal(500))).toBe("failed");
    expect(appPreviewProblem(new Error("offline"))).toBe("failed");
    expect(appPreviewProblemText("kit_unavailable", "draft")).toBe("apps.failedKit");
  });

  it("is starting until an address or a refusal arrives, and ready with an address", () => {
    expect(appPreviewState({ shown: false, problem: undefined })).toBe("starting");
    expect(appPreviewState({ shown: true, problem: "failed" })).toBe("ready");
    expect(notice(undefined)).toContain('data-preview-state="starting"');
  });

  it("leads to the draft where nothing is published, and nowhere for a reader who may not write it", () => {
    const stopped = notice("not_published");
    expect(stopped).toContain('data-preview-state="stopped"');
    expect(stopped).toContain("to the draft");
    const unavailable = notice("unavailable", "draft");
    expect(unavailable).toContain('data-preview-state="stopped"');
    expect(unavailable).not.toContain("to the draft");
    expect(unavailable).not.toContain("Try again");
  });

  it("fails with the way to ask again", () => {
    const markup = notice("kit_unavailable");
    expect(markup).toContain('data-preview-state="failed"');
    expect(markup).toContain(">Try again</button>");
  });
});

describe("Save as app and Save to draft", () => {
  const host = (overrides: Partial<AppsHost> = {}): AppsHost => ({
    enabled: true,
    rights: WRITER,
    workspace,
    showRoute() {},
    ...overrides
  });
  const action = (value: AppsHost | undefined) => {
    const control = createElement(SaveAsAppAction, {
      conversationId: "conv_1",
      pageId: "page_1",
      proposedName: "Angebotsrechner"
    });
    return render(value ? createElement(AppsHostProvider, { value, children: control }) : control);
  };
  const app = {
    name: "angebotsrechner",
    title: "Angebotsrechner",
    workspaceId: "cw_1",
    draftRevision: 1,
    draftFromPage: true
  };
  const named = { kind: "app", title: "Angebotsrechner" } as const;
  const unsaved = { kind: "unsaved" } as const;

  it("stands in the header of a Page for a writer of the workspace alone", () => {
    expect(action(host())).toContain(">Save as app</button>");
    expect(action(host({ enabled: false }))).toBe("");
    expect(action(host({ rights: READER }))).toBe("");
    expect(action(host({ workspace: undefined }))).toBe("");
    expect(action(undefined)).toBe("");
  });

  it("sends the name without its outer spaces and the id the agent's app.save makes of it", () => {
    expect(saveAsAppInput("  Angebotsrechner 2026 ")).toEqual({
      id: "angebotsrechner-2026",
      name: "Angebotsrechner 2026"
    });
    expect(saveAsAppInput("Über_uns")?.id).toBe("ueber-uns");
    expect(saveAsAppInput("   ")).toBeUndefined();
  });

  const saveDialog = (
    proposedName: string,
    failure: Parameters<typeof SaveAsAppDialogView>[0]["failure"],
    onLink?: () => void
  ) =>
    render(
      createElement(SaveAsAppDialogView, {
        workspaceName: "Nordlicht Beratung",
        proposedName,
        saving: false,
        failure,
        onClose() {},
        ...(onLink ? { onLink } : {}),
        onSave() {}
      })
    );

  // OPEN-1f design review: the refusal stayed under a name the person had changed since.
  it("shows a refusal only while the field holds the name it was sent with", () => {
    const taken = {
      name: "Angebotsrechner",
      field: "name" as const,
      message: t("apps.saveNameTaken")
    };
    expect(saveDialog("Angebotsrechner", taken)).toContain('aria-invalid="true"');
    for (const failure of [taken, { name: "Angebotsrechner", message: t("apps.saveFailed") }]) {
      const markup = saveDialog("Angebotsrechner 2026", failure);
      expect(markup).not.toContain(failure.message);
      expect(markup).not.toContain('aria-invalid="true"');
    }
  });

  it("offers to save to the draft of the App that has the id only to who may take it over", () => {
    const failure = {
      name: "Angebotsrechner",
      field: "name" as const,
      message: t("apps.saveNameTakenWritable", { name: app.title }),
      taken: { ...app, draftRevision: 4, page: "none" as const }
    };
    expect(saveDialog("Angebotsrechner", failure, noop)).toContain(
      ">Save to this app&#x27;s draft</button>"
    );
    expect(saveDialog("Angebotsrechner", failure)).not.toContain("Save to this app");
    expect(saveDialog("Angebotsrechner neu", failure, noop)).not.toContain("Save to this app");
  });

  it("offers the update of the App a Page was saved as, and Save as app for a Page no App holds", () => {
    expect(pageAppChoice(host(), { app, preview: named, settled: true })).toEqual({
      kind: "update",
      app
    });
    expect(pageAppChoice(host(), { app: undefined, preview: unsaved, settled: true })).toEqual({
      kind: "save"
    });
    // The instance names a writable App only to whoever may write it, so the update needs no
    // right of the open workspace; Save as app does.
    const reader = host({ rights: READER });
    expect(pageAppChoice(reader, { app, preview: named, settled: true })).toEqual({
      kind: "update",
      app
    });
    expect(pageAppChoice(reader, { app: undefined, preview: unsaved, settled: true })).toEqual({
      kind: "none"
    });
  });

  // Fails without the reader's standing of PREVIEW-1: a checkout whose App the reader may only
  // read, or not see, offered Save as app to whoever may write Apps in the open workspace.
  it("offers no save for the checkout of an App the reader may not write, whatever the workspace allows", () => {
    expect(pageAppChoice(host(), { app: undefined, preview: named, settled: true })).toEqual({
      kind: "none"
    });
    expect(
      pageAppChoice(host(), { app: undefined, preview: { kind: "neutral" }, settled: true })
    ).toEqual({ kind: "none" });
  });

  it("offers neither before the instance said whether the Page has an App, where it could not say, nor with the module off", () => {
    expect(pageAppChoice(host(), { app: undefined, settled: false })).toEqual({ kind: "none" });
    // A read that failed settles without a preview: the Page may still be an App's checkout.
    expect(pageAppChoice(host(), { app: undefined, settled: true })).toEqual({ kind: "none" });
    expect(pageAppChoice(host({ enabled: false }), { app, settled: true })).toEqual({
      kind: "none"
    });
    expect(pageAppChoice(host({ workspace: undefined }), { app, settled: true })).toEqual({
      kind: "none"
    });
    expect(pageAppChoice(undefined, { app, settled: true })).toEqual({ kind: "none" });
  });

  const updateDialog = (overrides: Partial<Parameters<typeof UpdateAppDialogView>[0]> = {}) =>
    render(
      createElement(UpdateAppDialogView, {
        name: "Angebotsrechner",
        phase: "idle",
        changedElsewhere: false,
        failure: undefined,
        onClose() {},
        onUpdate() {},
        onOpen() {},
        ...overrides
      })
    );

  it("holds both buttons while the update is on its way, and keeps the question open under a refusal", () => {
    const working = updateDialog({ phase: "working" });
    expect(working.match(/<button[^>]*disabled=""/gu)?.length).toBeGreaterThanOrEqual(2);
    const failed = updateDialog({ phase: "failed", failure: t("apps.updateFailed") });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(">Save to draft</button>");
  });

  it("replaces a draft changed somewhere else only by a button that says so", () => {
    expect(updateDialog()).toContain(">Save to draft</button>");
    const changed = updateDialog({ changedElsewhere: true });
    expect(changed).toContain(">Replace draft</button>");
    expect(changed).not.toContain(">Save to draft</button>");
    // Into an App that is not the Page's yet, the draft is replaced.
    expect(updateDialog({ link: "none", pageName: "Angebotsrechner" })).toContain(
      ">Replace draft</button>"
    );
  });

  it("offers Publish once saved to whoever may publish, and the App's page to everybody else", () => {
    const publisher = updateDialog({ phase: "done", onPublish() {} });
    expect(publisher).toContain(">Publish</button>");
    expect(publisher).not.toContain(">Open app</button>");
    const writer = updateDialog({ phase: "done" });
    expect(writer).toContain(">Open app</button>");
    expect(writer).not.toContain(">Publish</button>");
  });
});

// Every test of this block fails without PREVIEW-1: the head of a preview did not say whether it
// showed a folder no App holds or an App's checkout, which looks like the App and is not it.
describe("the standing of a preview", () => {
  const host = { enabled: true, workspace };
  const app = {
    name: "umsatz",
    title: "Umsatzübersicht",
    workspaceId: "cw_1",
    draftRevision: 3,
    draftFromPage: true
  };
  const named = { kind: "app", title: "Umsatzübersicht" } as const;
  const unsaved = previewStanding(host, {
    app: undefined,
    preview: { kind: "unsaved" },
    settled: true
  });
  const writer = previewStanding(host, { app, preview: named, settled: true });
  // Fails without the reader's standing: the checkout of an App the reader may read and not
  // write read as "not saved yet", because the instance named only Apps one may write.
  const reading = previewStanding(host, { app: undefined, preview: named, settled: true });

  it("tells a folder no App holds, an App's checkout, and one the reader may only read", () => {
    expect(unsaved).toEqual({ kind: "unsaved" });
    expect(writer).toEqual({ kind: "app", title: "Umsatzübersicht", app });
    expect(reading).toEqual({ kind: "app", title: "Umsatzübersicht", app: undefined });
    expect(
      previewStanding(host, { app: undefined, preview: { kind: "neutral" }, settled: true })
    ).toEqual({ kind: "neutral" });
  });

  it("says nothing before the instance answered or where no Apps are offered, and no more than a preview where it could not say", () => {
    expect(previewStanding(host, { app, settled: false })).toEqual({ kind: "unknown" });
    expect(previewStanding(host, { app: undefined, settled: true })).toEqual({ kind: "neutral" });
    expect(previewStanding({ enabled: false, workspace }, { app, settled: true })).toEqual({
      kind: "unknown"
    });
    expect(
      previewStanding({ enabled: true, workspace: undefined }, { app, settled: true })
    ).toEqual({ kind: "unknown" });
    expect(previewStanding(undefined, { app, settled: true })).toEqual({ kind: "unknown" });
  });

  it("leads to the App after a refused call only whoever may write it, and to Save as app only for a Page no App holds", () => {
    expect(previewNeedsApp(writer, false)).toEqual({ message: "pages.needsApp", app });
    expect(previewNeedsApp(unsaved, true)).toEqual({ message: "pages.needsAppUnsaved" });
    expect(previewNeedsApp(unsaved, false)).toEqual({ message: "pages.needsAppNoWay" });
    expect(previewNeedsApp(reading, true)).toEqual({ message: "pages.needsAppNoWay" });
    expect(previewNeedsApp({ kind: "neutral" }, true)).toEqual({ message: "pages.needsAppNoWay" });
    expect(previewNeedsApp({ kind: "unknown" }, true)).toEqual({ message: "pages.needsAppNoWay" });
  });
});

// APPCARD-1 (check 68): a conversation in which the agent saved one App three times shows one
// App card, at the newest save; the earlier saves are lines in the run's work. The newest
// preview of a folder is a card in the same way, and a folder that a save made into an App has
// the App's card stand for it.
describe("one card per App and per preview in a conversation", () => {
  const save = (toolCallId: string, path = "apps/findings", created = false) => ({
    type: "tool-call",
    toolCallId,
    toolName: "app.save",
    args: { path, name: "Findings" },
    result: { kind: "app", name: "findings", title: "Findings", saved: true, created, revision: 1 }
  });
  const open = (toolCallId: string, path: string, number = 1) => ({
    type: "tool-call",
    toolCallId,
    toolName: "workspace.open",
    args: { path },
    result: { pageId: "page_1", fileSetId: `fs_${toolCallId}`, number }
  });

  it("folds three saves of one App into one card at the newest, deciding per App across the conversation", () => {
    const saved = { type: "text", text: "Saved." };
    const folded = foldedCards([
      save("call_1", "apps/findings", true),
      saved,
      save("call_2"),
      save("call_3")
    ]);
    expect([...folded]).toEqual([
      ["call_1", "app_draft"],
      ["call_2", "app_draft"]
    ]);
    const other = {
      ...save("call_b"),
      result: { kind: "app", name: "orders", title: "Orders", saved: true, created: true }
    };
    const perApp = foldedCards([save("call_a1", "apps/findings", true), other, save("call_a2")]);
    expect(perApp.get("call_a1")).toBe("app_draft");
    expect(perApp.has("call_a2")).toBe(false);
    expect(perApp.has("call_b")).toBe(false);
  });

  it("counts a call shown twice once, and leaves a refused save and one that changed nothing out", () => {
    expect(foldedCards([save("call_1", "apps/findings", true), save("call_1")]).size).toBe(0);
    const refused = { ...save("call_2"), isError: true };
    const unchanged = {
      ...save("call_3"),
      result: { kind: "app", name: "findings", title: "Findings", saved: false, message: "x" }
    };
    expect(foldedCards([save("call_1", "apps/findings", true), refused, unchanged]).size).toBe(0);
  });

  it("keeps the newest preview of a folder as its card, and one that builds or was refused as its own", () => {
    expect([
      ...foldedCards([
        open("call_o1", "drafts/report"),
        open("call_o2", "./drafts/report/", 2),
        open("call_x", "drafts/other")
      ])
    ]).toEqual([["call_o1", "preview"]]);
    const building = { ...open("call_o2", "drafts/report"), result: undefined };
    const refused = {
      ...open("call_o3", "drafts/report"),
      result: { errors: [{ file: "index.html", message: "x" }] }
    };
    expect(foldedCards([open("call_o1", "drafts/report"), building, refused]).size).toBe(0);
  });

  it("folds every preview of a folder a save made into an App, the loaded app.edit preview too", () => {
    const folded = foldedCards([
      open("call_o1", "apps/findings"),
      save("call_s1", "apps/findings", true),
      open("call_o2", "apps/findings", 2),
      save("call_s2", "apps/findings")
    ]);
    expect(folded.get("call_o1")).toBe("preview");
    expect(folded.get("call_o2")).toBe("preview");
    expect(folded.get("call_s1")).toBe("app_draft");
    expect(folded.has("call_s2")).toBe(false);
    const loaded = {
      ...open("loaded", "apps/findings"),
      toolName: "app.edit",
      args: { name: "findings" },
      result: { ...open("loaded", "apps/findings").result, path: "apps/findings" }
    };
    expect([...foldedCards([loaded, open("changed", "apps/findings"), save("saved")])]).toEqual([
      ["loaded", "preview"],
      ["changed", "preview"]
    ]);
  });

  it("puts an earlier save in the run's work, also while the run goes, and keeps the newest as a card", () => {
    const toolCall = (call: ReturnType<typeof save>): PartState => ({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      argsText: "{}",
      result: call.result,
      status: { type: "complete" }
    });
    const parts: PartState[] = [
      toolCall(save("call_1", "apps/findings", true)),
      toolCall(save("call_2")),
      toolCall(save("call_3")),
      { type: "text", text: "Saved Findings.", status: { type: "complete" } }
    ];
    const folded = foldedCards(parts);
    expect(createCompletedAssistantWorkIndices(parts, 3, folded)).toEqual([0, 1]);
    expect(createVisibleFinalAssistantPartIndices(parts, 3, folded)).toEqual([3, 2]);
    // Without folds, every save stood as a card of its own.
    expect(createCompletedAssistantWorkIndices(parts, 3)).toEqual([]);
    const groupBy = createAssistantMessageGroupBy(folded);
    expect(parts.slice(0, 3).map((value) => groupBy(value, {}))).toEqual([
      ["group-work"],
      ["group-work"],
      []
    ]);
  });

  it("names the App a save wrote, as the card shows it", () => {
    expect(appSavedByCall(save("call_1", "apps/findings", true))).toEqual({
      name: "findings",
      title: "Findings",
      created: true
    });
  });
});

describe("the App's card", () => {
  const saved = { name: "findings", title: "Findings", created: true };
  const route = {
    kind: "app-edit" as const,
    collaborationWorkspaceId: workspace.id,
    app: "findings"
  };

  it("reads the App's live state, and the save's until the record is read", () => {
    expect(appCardState({ revision: 3, draftRevision: 3 }, saved)).toBe("saved_only_you");
    expect(appCardState({ revision: 3, draftRevision: 3, publishedRevision: 2 }, saved)).toBe(
      "draft_saved"
    );
    expect(appCardState({ revision: 3, draftRevision: 3, publishedRevision: 3 }, saved)).toBe(
      "published"
    );
    expect(appCardState(undefined, saved)).toBe("saved_only_you");
    expect(appCardState(undefined, { created: false })).toBe("draft_saved");
  });

  it("offers Open and Publish only to whom may do them, and nothing outside a workspace shell", () => {
    const card = (open: boolean, publish: boolean) =>
      render(
        createElement(AppCardView, {
          saved,
          state: "saved_only_you",
          ...(open ? { open: { route, onOpen: noop } } : {}),
          ...(publish ? { onPublish: noop } : {})
        })
      );
    expect(card(true, true)).toMatch(
      /data-testid="app-card-open"[^>]*href="\/w\/cw_1\/app-drafts\/findings"/u
    );
    expect(card(true, true)).toContain('data-testid="app-card-publish"');
    const reader = card(false, false);
    expect(reader).not.toContain("app-card-open");
    expect(reader).not.toContain("app-card-publish");

    const host: AppsHost = { enabled: false, rights: ALL, workspace, showRoute: noop };
    const outside = render(
      createElement(AppsHostProvider, {
        value: host,
        children: createElement(AppCard, { saved })
      })
    );
    expect(outside).toContain("Findings");
    expect(outside).not.toContain("app-card-publish");
  });

  it("tells the conversation once the draft went live, and not when the publish waits or was refused", () => {
    const onPublished = vi.fn();
    const onClose = vi.fn();
    afterPublishSend("waits", { onClose, onPublished });
    afterPublishSend("failed", { onClose, onPublished });
    expect(onPublished).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    afterPublishSend("published", { onClose, onPublished });
    expect(onPublished).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
