import { createElement, type ReactNode } from "react";
import {
  ApiError,
  appInterfacePath,
  type AssetSummary,
  type ConfigAssetRevision
} from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  AppDeleteDialog,
  appDraftIsAhead,
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
        children: createElement("p", null, "the app"),
        onBack() {},
        onEdit() {},
        onDetails() {},
        app: "fee-estimate"
      })
    );

  it("heads the App with the way back, its name and the published number for a builder", () => {
    const markup = frame(WRITER);
    const order = [
      'href="/w/cw_1/apps"',
      ">Angebotsrechner</h1>",
      "Published · revision 2",
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
    expect(markup).not.toContain("Published");
    expect(markup).not.toContain("Nordlicht Beratung");
    expect(markup).not.toContain('aria-label="More actions"');
    expect(markup).toMatch(/<button[^>]*>(?:<svg.*?<\/svg>)?Copy link<\/button>/u);
    expect(markup).not.toContain("Details");
    // A publisher is a builder and reads the number, also without the right to write.
    expect(frame({ ...NO_APP_RIGHTS, publish: true })).toContain("Published · revision 2");
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
        children: createElement("p", null, "the draft"),
        onBack() {}
      }),
      locale
    );
  const publishButton = (markup: string) =>
    /<button[^>]*>(?:(?!<\/button>).)*Publish<\/button>/u.exec(markup)?.[0] ?? "";

  it("heads the draft with its number, Discard, Publish and the overflow", () => {
    const markup = frame(ALL);
    const order = [
      ">Angebotsrechner</h1>",
      "Draft · revision 3",
      ">Discard</button>",
      "Publish</button>",
      'aria-label="More actions"',
      "the draft"
    ].map((part) => markup.indexOf(part));

    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(publishButton(markup)).not.toContain('disabled=""');
    expect(markup).not.toContain("You need the right");
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

    expect(appRefusalText(refused("revision_files_removed"))).toBe("apps.revisionFilesRemoved");
    expect(appRefusalText(refused("input_too_large_to_hold"))).toBe("apps.tooLargeToHold");
    // Every other refusal is shown as the instance said it.
    expect(appRefusalText(refused("something_else"))).toBeUndefined();
    expect(appRefusalText(new Error("offline"))).toBeUndefined();
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
      "Everyone in Nordlicht Beratung gets revision 3 when they open the app."
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

describe("the revisions of an App", () => {
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
  const drawer = (onPublish?: (revision: ConfigAssetRevision) => void) =>
    render(
      createElement(RevisionsDrawerView, {
        open: true,
        name: "Angebotsrechner",
        revisions: [revision(3), revision(2), revision(1)],
        failed: false,
        hasMore: false,
        loadingMore: false,
        draftRevision: 3,
        publishedRevision: 2,
        onPublish,
        onLoadMore() {},
        onRetry() {},
        onClose() {}
      })
    );

  it("lists who saved each revision and when, and marks the two pointers", () => {
    const markup = drawer();

    expect(markup).toContain("Every saved state of Angebotsrechner, the newest first.");
    expect(markup.match(/Jana Petersen/gu)).toHaveLength(3);
    expect(markup).toContain("Revision 3");
    expect(markup).toMatch(/data-revision="3"(?:(?!data-revision).)*>Draft</u);
    expect(markup).toMatch(/data-revision="2"(?:(?!data-revision).)*>Published</u);
    expect(markup).not.toContain("Publish this revision");
  });

  it("lets a holder of the publish right publish every revision but the published one", () => {
    const markup = drawer(() => undefined);

    expect(markup.match(/Publish this revision/gu)).toHaveLength(2);
    expect(markup).not.toMatch(/data-revision="2"(?:(?!data-revision).)*Publish this revision/u);
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
