import { createElement, type ReactNode } from "react";
import {
  ApiError,
  appInterfacePath,
  type AssetSummary,
  type ConfigAssetPublication,
  type ConfigAssetRevision
} from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  AppDeleteDialog,
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
  AppViewFrame,
  NO_APP_RIGHTS,
  PublishDialog,
  resolveAppRights,
  RevisionsDrawerView,
  SaveAsAppAction,
  SaveAsAppDialogView,
  saveAsAppInput,
  type AppRights,
  type AppsHost,
  areaOfRoute,
  railSections,
  shownRailSections,
  workspaceRouteFromPath,
  workspaceRouteNavigation,
  workspaceRoutePath
} from "@work-shape/catalyst-chat-ui/apps";
import { appsContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Apps area: its addresses, what a reader is offered by the rights they hold, and what
// each screen shows. Every test here fails without the area: the modules it reads did not
// exist, and the route table had no row for it.

const { t } = createTranslationContext("en");

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const workspace = { id: "cw_1", name: "Nordlicht Beratung", emoji: null };
const ALL: AppRights = { read: true, write: true, publish: true, delete: true };
const ALL_NAMES = ["app.read", "app.write", "app.publish", "app.delete"];
const WRITER: AppRights = { read: true, write: true, publish: false, delete: false };

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
    expect(resolveAppRights(context, "cw_open")).toEqual({
      read: true,
      write: true,
      publish: false,
      delete: false
    });
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
    const draftOnly = appState(summary({ publishedRevision: undefined }));

    expect(appRowActions(ALL, published, true)).toEqual([
      "open",
      "edit",
      "details",
      "copy_link",
      "delete"
    ]);
    expect(appRowActions(WRITER, published, true)).toEqual([
      "open",
      "edit",
      "details",
      "copy_link"
    ]);
    // A writer who was shown the published view alone has no draft to edit.
    expect(appRowActions(WRITER, published, false)).toEqual(["open", "details", "copy_link"]);
    expect(appRowActions(NO_APP_RIGHTS, published, false)).toEqual(["open", "copy_link"]);
    // Nothing is served yet: there is nothing to open and no address to hand on.
    expect(appRowActions(ALL, draftOnly, true)).toEqual(["edit", "details", "delete"]);
  });

  it("leads a row to the App, or to the draft for a writer while nothing is published", () => {
    const address = { collaborationWorkspaceId: "cw_1", app: "angebotsrechner" };
    const draftOnly = appState(summary({ publishedRevision: undefined }));

    expect(appRowRoute("cw_1", summary(), appState(summary()), NO_APP_RIGHTS)).toEqual({
      kind: "app",
      ...address
    });
    expect(appRowRoute("cw_1", summary(), draftOnly, WRITER)).toEqual({
      kind: "app-edit",
      ...address
    });
    expect(appRowRoute("cw_1", summary(), draftOnly, { ...NO_APP_RIGHTS, read: true })).toBe(
      undefined
    );
  });
});

describe("an open App (layout 2)", () => {
  const frame = (
    rights: AppRights,
    served: { revision?: number } = { revision: 2 },
    draftShown = true,
    dataSources?: readonly string[]
  ) =>
    render(
      createElement(AppViewFrame, {
        dataSources,
        draftShown,
        name: "Angebotsrechner",
        workspace,
        rights,
        publishedRevision: served.revision,
        liveVersion: { number: 5, publishedAt: "2026-10-26T09:00:00.000Z" },
        children: createElement("p", null, "the app"),
        onBack() {},
        onEdit() {},
        onDetails() {},
        app: "fee-estimate"
      })
    );

  it("explains an App's empty scoped read in both languages outside its frame", () => {
    const node = createElement(AppViewFrame, {
      name: "Findings",
      app: "findings",
      draftShown: false,
      workspace,
      rights: NO_APP_RIGHTS,
      publishedRevision: 1,
      unassignedScopes: ["Mandant"],
      children: createElement("p", null, "the app"),
      onBack() {},
      onEdit() {},
      onDetails() {}
    });
    expect(render(node, "de")).toContain("Ihnen ist kein Mandant zugeordnet");
    expect(render(node, "en")).toContain("No Mandant is assigned to you.");
  });
  it("heads the App with the way back, its name and the published number for a builder", () => {
    const markup = frame(WRITER);
    const order = [
      'href="/w/cw_1/apps"',
      ">Angebotsrechner</h1>",
      "Live: version 5 · since Oct 26",
      'aria-label="More actions"',
      "the app"
    ].map((part) => markup.indexOf(part));

    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(markup).toContain('aria-label="Back to Apps"');
    // The App is open inside its workspace: the head does not name it.
    expect(markup).not.toContain("Nordlicht Beratung");
  });

  it("heads the App for whoever uses it with its name and one button that copies its link", () => {
    const markup = frame(NO_APP_RIGHTS);

    expect(markup).toContain(">Angebotsrechner</h1>");
    expect(markup).not.toContain("Live:");
    expect(markup).not.toContain("Nordlicht Beratung");
    expect(markup).not.toContain('aria-label="More actions"');
    expect(markup).toMatch(/<button[^>]*>(?:<svg.*?<\/svg>)?Copy link<\/button>/u);
    expect(markup).not.toContain("Details");
    // A publisher is a builder and reads the number, also without the right to write.
    expect(frame({ ...NO_APP_RIGHTS, publish: true })).toContain("Live: version 5");
  });

  it("tells whoever uses the App where its data comes from, with no right to read the App", () => {
    const line = "Shows data from “Clients”, which the Workflow “Nightly import” copies from CRM.";
    const user = frame(NO_APP_RIGHTS, { revision: 2 }, true, [line]);
    expect(user).toContain('aria-label="Where the data comes from"');
    expect(frame(WRITER, { revision: 2 }, true, [line])).toContain(
      'aria-label="Where the data comes from"'
    );
    // Nothing is offered while it is read, or for an App that reads no store.
    expect(frame(NO_APP_RIGHTS)).not.toContain("Where the data comes from");
    expect(frame(NO_APP_RIGHTS, { revision: 2 }, true, [])).not.toContain(
      "Where the data comes from"
    );
  });

  it("offers Edit to a writer and to nobody else", () => {
    expect(frame(WRITER)).toContain("Edit</button>");
    expect(frame(NO_APP_RIGHTS)).not.toContain("Edit</button>");
    // The published view names no draft: there is none to edit, whatever the reader holds.
    expect(frame(WRITER, { revision: 2 }, false)).not.toContain("Edit</button>");
  });

  // Fails with Edit among the secondary actions: at 390 in German both folded and the head
  // showed only "…". Edit is the head's primary action, which never folds.
  it("keeps Edit as the head's primary action, so only the agent's action folds", () => {
    const markup = frame(WRITER);
    const measured = /<div[^>]*inert[^>]*>(.*?)<\/div>/u.exec(markup)?.[1] ?? "";

    expect(markup).toMatch(/<button[^>]*>(?:<svg.*?<\/svg>)?Edit<\/button>/u);
    expect(measured).not.toContain("Edit<");
  });

  it("shows no number before the instance said which revision is served", () => {
    expect(frame(WRITER, {})).not.toContain("Published");
  });
});

describe("the draft of an App (layout 3)", () => {
  const frame = (
    rights: AppRights,
    revisions: { draftRevision?: number; publishedRevision?: number } = {
      draftRevision: 3,
      publishedRevision: 2
    },
    locale: "en" | "de" = "en"
  ) =>
    render(
      createElement(AppEditFrame, {
        name: "Angebotsrechner",
        workspace,
        rights,
        ...revisions,
        ...(revisions.publishedRevision === undefined
          ? {}
          : { liveVersion: { number: 1, publishedAt: "2026-10-26T09:00:00.000Z" } }),
        children: createElement("p", null, "the draft"),
        onBack() {}
      }),
      locale
    );
  const publishButton = (markup: string) =>
    /<button[^>]*>(?:(?!<\/button>).)*Publish<\/button>/u.exec(markup)?.[0] ?? "";

  it("heads the draft with the live version, Discard, Publish and the overflow", () => {
    const markup = frame(ALL);
    const order = [
      ">Angebotsrechner</h1>",
      "Live: version 1 · since Oct 26",
      "Draft: changed since version 1",
      ">Discard</button>",
      "Publish</button>",
      'aria-label="More actions"',
      "the draft"
    ].map((part) => markup.indexOf(part));

    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(publishButton(markup)).not.toContain('disabled=""');
    expect(markup).not.toContain("You need the right");
    // The revisions, 3 and 2, are no member's number.
    expect(markup).not.toMatch(/version [23]\b/u);
  });

  it("holds Publish for a writer without the publish right, and names the right", () => {
    const markup = frame(WRITER);

    expect(publishButton(markup)).toContain('disabled=""');
    expect(markup).toContain("You need the right “app.publish” to publish.");
    // The sentence is the button's description, so it is read out with the button.
    const id = /aria-describedby="([^"]+)"/u.exec(publishButton(markup))?.[1];
    expect(id).toBeDefined();
    expect(markup).toContain(`<span id="${id}">You need the right`);
    expect(frame(WRITER, undefined, "de")).toContain(
      "Zum Veröffentlichen brauchst du das Recht „app.publish“."
    );
  });

  it("offers Discard only while something is published that the draft is ahead of", () => {
    expect(appDraftIsAhead(3, 2)).toBe(true);
    expect(appDraftIsAhead(2, 2)).toBe(false);
    expect(appDraftIsAhead(1, undefined)).toBe(true);
    expect(frame(ALL, { draftRevision: 2, publishedRevision: 2 })).not.toContain("Discard");
    expect(frame(ALL, { draftRevision: 1 })).not.toContain("Discard");
    // A draft that is what is published may still be published for another audience
    // (SHARE-1): the dialog holds Publish until the choice differs from the live one.
    expect(publishButton(frame(ALL, { draftRevision: 2, publishedRevision: 2 }))).not.toContain(
      'disabled=""'
    );
  });

  const headed = (extra: Partial<Parameters<typeof AppEditFrame>[0]>, locale: "en" | "de" = "en") =>
    render(
      createElement(AppEditFrame, {
        name: "Angebotsrechner",
        workspace,
        rights: ALL,
        draftRevision: 3,
        publishedRevision: 2,
        children: createElement("p", null, "the draft"),
        onBack() {},
        ...extra
      }),
      locale
    );
  const draftLine = (markup: string) =>
    /data-testid="app-draft-line"[^>]*>((?:(?!<\/div>).)*)/u
      .exec(markup)?.[1]
      ?.replace(/<[^>]*>/gu, "") ?? "";

  // DAILY-WINS 6: the head says what a draft does and what is live beside it (Apps check 45);
  // the live version and its day stand in the head's badge (APPVER-1).
  it("says the draft reads live data and simulates changes, and who made what is live", () => {
    const live = {
      liveVersion: { number: 4, publishedAt: "2026-10-12T14:05:00.000Z", by: "Anna Beispiel" }
    };

    expect(headed(live)).toContain("Live: version 4 · since Oct 12");
    expect(draftLine(headed(live))).toBe(
      "Draft · reads live data · changes are simulated · Version 4 published by Anna Beispiel"
    );
    expect(draftLine(headed(live, "de"))).toBe(
      "Entwurf · liest Live-Daten · Änderungen werden simuliert · Version 4 veröffentlicht von Anna Beispiel"
    );
    // A version without a person, as one from before versions were recorded, names nobody.
    expect(
      draftLine(headed({ liveVersion: { number: 1, publishedAt: "2026-10-12T14:05:00.000Z" } }))
    ).toBe("Draft · reads live data · changes are simulated");
    const undated = headed({ liveVersion: { number: 1 } });
    expect(undated).toContain("Live: version 1");
    expect(undated).not.toContain("· since");
    expect(headed({ liveVersion: { number: 1 } }, "de")).not.toContain("· seit");
    // A draft never published says so in the head, and the line says what a draft does.
    const never = headed({ publishedRevision: undefined }, "de");
    expect(never).toContain("Entwurf · noch nicht veröffentlicht");
    expect(draftLine(never)).toBe("Entwurf · liest Live-Daten · Änderungen werden simuliert");
    expect(headed({ rights: NO_APP_RIGHTS, ...live })).not.toContain("app-draft-line");
  });

  // DAILY-WINS 7: the draft says where its data comes from, as the open App does.
  it("offers where the data comes from in the draft's head", () => {
    const sources = ["Kunden is filled by the Workflow “Nachtimport”."];
    expect(headed({ dataSources: sources })).toContain('aria-label="Where the data comes from"');
    expect(headed({ dataSources: [] })).not.toContain("Where the data comes from");
    expect(headed({})).not.toContain("Where the data comes from");
  });

  it("shows a reader without the write right no action at all", () => {
    const markup = frame(NO_APP_RIGHTS);

    expect(markup).not.toContain("Publish");
    expect(markup).not.toContain("Discard");
    expect(markup).not.toContain("More actions");
    expect(markup).not.toContain("revision 3");
  });

  const viewsFrame = (detailsOpen: boolean) =>
    render(
      createElement(AppEditFrame, {
        name: "Angebotsrechner",
        workspace,
        rights: ALL,
        draftRevision: 3,
        publishedRevision: 2,
        view: "preview",
        detailsOpen,
        children: createElement("p", null, "the draft"),
        onViewChange() {},
        onDetailsOpenChange() {},
        onBack() {}
      })
    );
  const tabNames = (markup: string) =>
    [...markup.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/gu)].map((tab) => tab[1]);
  const detailsToggle = (markup: string) =>
    /<button[^>]*aria-expanded="(?:true|false)"[^>]*><span[^>]*>Technical details/u.exec(
      markup
    )?.[0] ?? "";

  it("offers the views of the draft as tabs under its head, the open one selected", () => {
    const markup = viewsFrame(true);

    expect(tabNames(markup)).toEqual(["Preview", "Files", "Actions"]);
    expect(markup).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Preview</u);
    expect(markup).toContain('role="tabpanel"');
    expect(markup).not.toContain('role="radio"');
    // The tabs stand under the head, before the view they show.
    expect(markup.indexOf('role="tablist"')).toBeGreaterThan(markup.indexOf("</header>"));
    expect(markup.indexOf("the draft")).toBeGreaterThan(markup.indexOf('role="tablist"'));
    expect(detailsToggle(markup)).toContain('aria-expanded="true"');
  });

  it("folds Files and Actions under Technical details, a line outside the tabs", () => {
    const markup = viewsFrame(false);

    expect(tabNames(markup)).toEqual(["Preview"]);
    const toggle = detailsToggle(markup);
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).not.toContain('role="tab"');
    // The line stands after the set of tabs, not inside it.
    const list = /<div[^>]*role="tablist"[^>]*>.*?<\/div>/u.exec(markup)?.[0] ?? "";
    expect(list).not.toContain("Technical details");
    expect(markup.indexOf("Technical details")).toBeGreaterThan(markup.indexOf('role="tablist"'));
  });

  it("says in its own words that a revision lost its files or is too large to be held", () => {
    const refused = (reason: string) =>
      new ApiError(422, "As the instance says it", {
        error: { code: "VALIDATION_FAILED", details: { reason } }
      });

    const { t } = createTranslationContext("en");
    expect(appRefusalText(refused("revision_files_removed"), t)).toBe(
      "The files of this version are not stored any more, so it cannot be published or shown."
    );
    expect(appRefusalText(refused("input_too_large_to_hold"), t)).toBe(
      "This change needs an approval, and it is too large to be held for one."
    );
    // Every other refusal is shown as the instance said it.
    expect(appRefusalText(refused("something_else"), t)).toBeUndefined();
    expect(appRefusalText(new Error("offline"), t)).toBeUndefined();
  });

  it("asks once before publishing, with the Connections and hosts the revision reaches", () => {
    const markup = render(
      createElement(PublishDialog, {
        name: "Angebotsrechner",
        workspace,
        ask: {
          revision: 3,
          summary: appManifestSummary({
            manifest: {
              connections: ["crm"],
              actions: [{ name: "kunden_lesen", effect: "reading" }],
              externalHosts: ["api.example.com"]
            }
          }),
          readsStoredData: false
        },
        loading: false,
        error: undefined,
        onConfirm() {},
        onClose() {}
      })
    );

    expect(markup).toContain("Publish “Angebotsrechner”?");
    expect(markup).toContain(
      "Everyone in Nordlicht Beratung gets this state when they open the app."
    );
    expect(markup).toContain("Connections it uses");
    expect(markup).toContain(">crm</code>");
    expect(markup).toContain("External hosts it calls");
    expect(markup).toContain(">api.example.com</code>");
    expect(markup).toContain(">Publish</button>");
  });

  it("reads a manifest nobody vouches for without trusting its shape", () => {
    expect(appManifestSummary(undefined)).toEqual({ connections: [], actions: [], hosts: [] });
    expect(
      appManifestSummary({ manifest: { connections: "crm", actions: [{}, { name: 7 }, "x"] } })
    ).toEqual({ connections: [], actions: [], hosts: [] });
  });

  it("names the App it is about to delete", () => {
    const markup = render(
      createElement(AppDeleteDialog, {
        name: "Angebotsrechner",
        loading: false,
        error: undefined,
        onConfirm() {},
        onClose() {}
      })
    );

    expect(markup).toContain("Delete “Angebotsrechner”?");
    expect(markup).toContain(">Delete</button>");
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
  // Five saves and three publishes: revision 1, then 3, then back to 1. The newest save is the
  // agent's, the second one was saved from a preview.
  const publications = [
    publication(3, 1, 4, "Jana Petersen"),
    publication(2, 3, 3, "Jana Petersen"),
    publication(1, 1, 1)
  ];
  const revisions = [
    revision(5, {
      origin: { kind: "agent_run", conversationId: "conv_1", agentDisplayName: "Report assistant" }
    }),
    revision(4),
    revision(3),
    revision(2, {
      origin: { kind: "page", conversationId: "conv_1", pageId: "page_1", fileSetNumber: 2 }
    }),
    revision(1)
  ];
  const drawer = (
    onPublish?: (revision: ConfigAssetRevision) => void,
    locale: "en" | "de" = "en"
  ) =>
    render(
      createElement(RevisionsDrawerView, {
        open: true,
        name: "Angebotsrechner",
        publications,
        revisions,
        failed: false,
        hasMore: false,
        loadingMore: false,
        draftRevision: 5,
        publishedRevision: 1,
        onPublish,
        onLoadMore() {},
        onRetry() {},
        onClose() {}
      }),
      locale
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
  });

  it("reads one save published once as version 1 alone", () => {
    expect(appHistory([publication(1, 1, 1)], [revision(1)], true)).toEqual({
      versions: [{ publication: publication(1, 1, 1), saves: [] }],
      before: []
    });
  });

  it("folds under each version only the saves after it, and keeps earlier saves before 1", () => {
    // Saved 1, 2 and 3; published 2 as version 1 and 4 as version 2; saved 5 since.
    const second = [publication(2, 4, 4), publication(1, 2, 2)];
    const saves = [revision(5), revision(4), revision(3), revision(2), revision(1)];
    expect(appHistory(second, saves, true)).toEqual({
      versions: [
        { publication: second[0], saves: [saves[0]] },
        { publication: second[1], saves: [saves[2]] }
      ],
      before: [saves[4]]
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

  it("names each version, who published it and when, and the saves after it, without a revision number", () => {
    const markup = drawer();

    expect(markup).toContain(
      "Every version of Angebotsrechner with the draft saves after it, the newest first."
    );
    const order = ["Version 3", "Version 2", "Version 1"].map((part) => markup.indexOf(part));
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(markup).toMatch(/data-version="3"(?:(?!data-version).)*>Published</u);
    expect(markup).not.toMatch(/data-version="[12]"(?:(?!data-version).)*>Published</u);
    expect(markup).toContain("Published by Jana Petersen · ");
    // The version from before versions were recorded names nobody.
    expect(markup).toMatch(/data-version="1"(?:(?!data-version).)*Published · /u);
    expect(markup.match(/>1 draft save</gu)).toHaveLength(3);
    expect(markup).not.toContain("before version 1");
    // A save a version made live is that version's row, not a draft save as well.
    expect(markup).not.toMatch(/data-revision="[13]"/u);
    expect(markup).toContain("Report assistant for Jana Petersen");
    expect(markup).toMatch(/data-revision="2"(?:(?!data-revision).)*Saved from the preview/u);
    expect(markup).toMatch(/data-revision="5"(?:(?!data-revision).)*>Draft</u);
    expect(markup).not.toMatch(/Version [45]/u);
    expect(markup).not.toContain("Publish this save");
    const german = drawer(undefined, "de");
    expect(german).toContain("Veröffentlicht von Jana Petersen · ");
    expect(german).toContain(">1 Entwurfsstand<");
    expect(german).toContain("Report assistant für Jana Petersen");
    expect(german).toContain("Aus der Vorschau gespeichert");
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
    for (const locale of ["en", "de"] as const) {
      const markup = render(
        createElement(RevisionsDrawerView, {
          open: true,
          name: "Angebotsrechner",
          publications: [unknown],
          revisions: saves,
          failed: false,
          hasMore: false,
          loadingMore: false,
          draftRevision: 4,
          publishedRevision: 2,
          onLoadMore() {},
          onRetry() {},
          onClose() {}
        }),
        locale
      );
      expect(markup).toContain(
        locale === "en" ? "Agent for Jana Petersen" : "Agent für Jana Petersen"
      );
      expect(markup).toContain(
        locale === "en" ? "Page helper for Jana Petersen" : "Page helper für Jana Petersen"
      );
      expect(markup).not.toContain("Workshaper");
      expect(markup).not.toContain("Invalid Date");
      expect(markup).not.toMatch(/before version 1|vor Version 1/u);
    }
  });

  it("lets a holder of the publish right publish every save and version but the live one", () => {
    const markup = drawer(() => undefined);

    expect(markup.match(/Publish this save/gu)).toHaveLength(3);
    // Version 2 may be published again; versions 3 and 1 are the live revision.
    expect(markup.match(/Publish again/gu)).toHaveLength(1);
    expect(markup).toMatch(/data-version="2"(?:(?!data-version).)*Publish again/u);
    const german = drawer(() => undefined, "de");
    expect(german).toContain("Diesen Stand veröffentlichen");
    expect(german).toContain("Erneut veröffentlichen");
  });

  it("says before version 1 only the saves that never became a version", () => {
    const markup = render(
      createElement(RevisionsDrawerView, {
        open: true,
        name: "Angebotsrechner",
        publications: [publication(1, 2, 2)],
        revisions: [revision(2), revision(1)],
        failed: false,
        hasMore: false,
        loadingMore: false,
        draftRevision: 2,
        publishedRevision: 2,
        onLoadMore() {},
        onRetry() {},
        onClose() {}
      }),
      "de"
    );
    expect(markup).toContain("Version 1");
    expect(markup).toContain(">1 Entwurfsstand vor Version 1<");
    expect(markup.match(/data-revision="/gu)).toHaveLength(1);
  });

  it("lists the saves of an App never published as they are", () => {
    const markup = render(
      createElement(RevisionsDrawerView, {
        open: true,
        name: "Angebotsrechner",
        publications: [],
        revisions: [revision(2), revision(1)],
        failed: false,
        hasMore: false,
        loadingMore: false,
        draftRevision: 2,
        publishedRevision: undefined,
        onLoadMore() {},
        onRetry() {},
        onClose() {}
      })
    );
    expect(markup.match(/data-revision="/gu)).toHaveLength(2);
    expect(markup).toContain("Jana Petersen");
    expect(markup).not.toMatch(/\d draft saves?/u);
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
  });

  it("is starting until an address or a refusal arrives, and ready with an address", () => {
    expect(appPreviewState({ shown: false, problem: undefined })).toBe("starting");
    expect(appPreviewState({ shown: true, problem: "failed" })).toBe("ready");
    expect(notice(undefined)).toContain('data-preview-state="starting"');
    expect(notice(undefined)).toContain("The app is starting");
  });

  it("is stopped for an App without a published revision, with the way to its draft", () => {
    const markup = notice("not_published");

    expect(markup).toContain('data-preview-state="stopped"');
    expect(markup).toContain("This app has not been published yet.");
    expect(markup).toContain("to the draft");
  });

  it("says that the draft is not there for a reader who may not write it", () => {
    const markup = notice("unavailable", "draft");

    expect(markup).toContain('data-preview-state="stopped"');
    expect(markup).toContain("The draft of this app is not available to you.");
    expect(markup).not.toContain("to the draft");
    expect(markup).not.toContain("Try again");
    expect(notice("unavailable")).toContain("This app is not available to you.");
  });

  it("fails with the reason, and offers to ask again", () => {
    for (const [problem, sentence] of [
      ["kit_unavailable", t("apps.failedKit")],
      ["file_set_unknown", t("apps.failedFileSet")],
      ["failed", t("apps.failed")]
    ] as const) {
      const markup = notice(problem);
      expect(markup).toContain('data-preview-state="failed"');
      expect(markup).toContain(sentence);
      expect(markup).toContain(">Try again</button>");
    }
    expect(appPreviewProblemText("kit_unavailable", "draft")).toBe("apps.failedKit");
  });
});

describe("Save as app", () => {
  const host = (overrides: Partial<AppsHost> = {}): AppsHost => ({
    enabled: true,
    rights: WRITER,
    workspace,
    showRoute() {},
    startChat() {},
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

  it("stands in the header of a Page for a writer of the workspace", () => {
    expect(action(host())).toContain(">Save as app</button>");
    // The same action twice: with its words, and as its icon where the header is narrow.
    expect(action(host()).match(/<button/gu)).toHaveLength(2);
    expect(action(host())).toContain('aria-label="Save as app"');
  });

  it("is absent with the module off, without the write right and outside a workspace", () => {
    expect(action(host({ enabled: false }))).toBe("");
    expect(action(host({ rights: { ...NO_APP_RIGHTS, read: true } }))).toBe("");
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

  // OPEN-1f: saving asks for the name alone. Fails with the ID field the dialog had before.
  it("asks for the name only: no id and no scope", () => {
    const markup = render(
      createElement(SaveAsAppDialogView, {
        workspaceName: "Nordlicht Beratung",
        proposedName: "Angebotsrechner 2026",
        saving: false,
        failure: undefined,
        onClose() {},
        onSave() {}
      })
    );

    expect(markup).toContain("Save as app");
    expect(markup).toContain(
      "What this preview shows becomes the draft of a new app in Nordlicht Beratung. Nothing is published yet."
    );
    expect(markup.match(/<input/gu)).toHaveLength(1);
    expect(markup).toContain('value="Angebotsrechner 2026"');
    expect(markup).not.toContain("angebotsrechner-2026");
    expect(markup).not.toMatch(/>ID</u);
    expect(markup).not.toContain("<select");
    expect(markup).not.toMatch(/scope/iu);
  });

  const refusedAs = (proposedName: string, refusedName: string, field?: "name") =>
    render(
      createElement(SaveAsAppDialogView, {
        workspaceName: "Nordlicht Beratung",
        proposedName,
        saving: false,
        failure: {
          name: refusedName,
          ...(field ? { field } : {}),
          message: t(field ? "apps.saveNameTaken" : "apps.saveFailed")
        },
        onClose() {},
        onSave() {}
      })
    );

  it("says at the name that it is taken", () => {
    const markup = refusedAs("Angebotsrechner", "Angebotsrechner", "name");

    expect(markup).toContain("This name is already taken. Choose another name.");
    expect(markup).toContain('aria-invalid="true"');
    // Nothing is offered about an App the reader may not write.
    expect(markup.match(/<button/gu)).toHaveLength(3);
  });

  // OPEN-1f design review: the refusal stayed under a name the person had changed since.
  it("shows a refusal only while the field holds the name it was sent with", () => {
    for (const field of ["name", undefined] as const) {
      const markup = refusedAs("Angebotsrechner 2026", "Angebotsrechner", field);
      expect(markup).not.toContain("already taken");
      expect(markup).not.toContain("could not be saved");
      expect(markup).not.toContain('aria-invalid="true"');
    }
    expect(refusedAs("Angebotsrechner ", "Angebotsrechner")).toContain(
      "This could not be saved as an app."
    );
  });
});
