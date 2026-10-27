import { useState } from "react";
import { Banner, Button, RegistryIcon } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import {
  useAppFromPage,
  type AppFromPage,
  type AppFromPageRead,
  type AppLinkCandidate
} from "./app-data";
import { useAppsHost, type AppsHost } from "./apps-host";
import { PageHeaderAction } from "./page-header-action";
import { SaveAsAppAction } from "./save-as-app-dialog";
import { UpdateAppAction, UpdateAppDialog } from "./update-app-dialog";

/** What the header of a Page offers about Apps. */
type PageAppChoice = { kind: "none" } | { kind: "save" } | { kind: "update"; app: AppFromPage };

/**
 * Which of the two the header of a Page offers. A Page whose App the reader may write offers
 * the update of that App, whatever the reader may do in the open workspace. A Page no App holds
 * offers Save as app to whoever may write Apps there. A Page held by an App the reader may only
 * read, or not even that, offers nothing: saving it as a new App would copy someone else's App.
 * Until the instance said what the Page is, or where it could not say, it offers neither, so one
 * action never turns into the other under the pointer.
 */
export function pageAppChoice(
  host: Pick<AppsHost, "enabled" | "rights" | "workspace"> | undefined,
  read: AppFromPageRead
): PageAppChoice {
  if (!host?.enabled || !host.workspace || !read.settled) {
    return { kind: "none" };
  }
  if (read.app) {
    return { kind: "update", app: read.app };
  }
  return host.rights.write && read.preview?.kind === "unsaved"
    ? { kind: "save" }
    : { kind: "none" };
}

/**
 * What a preview is (PREVIEW-1): a folder no App holds, or the checkout of an App, which looks
 * like the App but reaches no Data Store and runs no Workflow of it. The App is named to whoever
 * may read it; `app` is there only where the reader may also write it. `neutral` where the App
 * may not be named to the reader, or where the instance could not say. `unknown` until the
 * instance said, and where no Apps are offered.
 */
type PreviewStanding =
  | { kind: "unknown" }
  | { kind: "unsaved" }
  | { kind: "neutral" }
  | { kind: "app"; title: string; app: AppFromPage | undefined };

export function previewStanding(
  host: Pick<AppsHost, "enabled" | "workspace"> | undefined,
  read: AppFromPageRead
): PreviewStanding {
  if (!host?.enabled || !host.workspace || !read.settled) {
    return { kind: "unknown" };
  }
  if (read.app) {
    return { kind: "app", title: read.app.title, app: read.app };
  }
  const preview = read.preview;
  if (preview?.kind === "app") {
    return { kind: "app", title: preview.title, app: undefined };
  }
  return preview?.kind === "unsaved" ? { kind: "unsaved" } : { kind: "neutral" };
}

/** The line under the name of a preview that says what it is, by its standing. */
export function previewStateLine(
  standing: PreviewStanding,
  t: TranslationContextValue["t"]
): string | undefined {
  switch (standing.kind) {
    case "app":
      return t("pages.stateOfApp", { app: standing.title });
    case "unsaved":
      return t("pages.stateUnsaved");
    case "neutral":
      return t("pages.preview");
    default:
      return undefined;
  }
}

/** The Page of a conversation that a preview shows. */
interface PreviewOfPage {
  conversationId: string;
  pageId: string;
}

/**
 * The standing of a preview and the way to its App: the App's draft page with this
 * conversation in the dock. Asks the instance only where Apps are offered; the header, its
 * state line and the notice share the one request.
 */
function usePreviewStanding({ conversationId, pageId }: PreviewOfPage) {
  const host = useAppsHost();
  const read = useAppFromPage(conversationId, pageId, appsOffered(host));
  const standing = previewStanding(host, read);
  const openApp = (app: Pick<AppFromPage, "name" | "workspaceId">) =>
    host?.showRoute(
      { kind: "app-edit", collaborationWorkspaceId: app.workspaceId, app: app.name },
      { chat: conversationId }
    );
  return { host, read, standing, openApp };
}

/** Apps are offered where the preview is shown: the module is on and a workspace is open. */
function appsOffered(host: AppsHost | undefined): boolean {
  return host?.enabled === true && host.workspace !== undefined;
}

/**
 * The state line of a preview, a quiet band right under the head of the surface. It wraps
 * rather than being cut: the head of a preview beside the chat leaves its name a few words.
 */
export function PreviewStateLine(props: PreviewOfPage) {
  return appsOffered(useAppsHost()) ? <PreviewStateLineOf {...props} /> : null;
}

function PreviewStateLineOf(props: PreviewOfPage) {
  const { t } = useTranslation();
  const { standing } = usePreviewStanding(props);
  const line = previewStateLine(standing, t);
  // Until the instance answered, the band keeps its room, so the preview does not move.
  return (
    <Banner
      layout="line"
      icon={line === undefined ? null : undefined}
      className="shrink-0 border-b bg-card px-4 py-2"
      data-testid="preview-state"
      data-standing={standing.kind}
    >
      {line ?? "\u00a0"}
    </Banner>
  );
}

/**
 * Under the head of a preview, after one of its calls was refused because the preview is no
 * App: where to test with real data. For an App's checkout, the way to the App.
 */
export function PreviewNeedsAppNotice(props: PreviewOfPage) {
  return appsOffered(useAppsHost()) ? <PreviewNeedsAppNoticeOf {...props} /> : null;
}

/**
 * What the notice of a refused call says, and whether it leads to the App. The way to the App is
 * its draft page, which only whoever may write the App can use. Save as app is named only for a
 * Page no App holds, to whoever may write Apps here. Everyone else reads what the preview cannot
 * do and no way they could not take.
 */
export function previewNeedsApp(
  standing: PreviewStanding,
  mayWriteApps: boolean
):
  | { message: "pages.needsApp"; app: AppFromPage }
  | {
      message: "pages.needsAppUnsaved" | "pages.needsAppNoWay";
    } {
  if (standing.kind === "app" && standing.app) {
    return { message: "pages.needsApp", app: standing.app };
  }
  return {
    message:
      standing.kind === "unsaved" && mayWriteApps ? "pages.needsAppUnsaved" : "pages.needsAppNoWay"
  };
}

function PreviewNeedsAppNoticeOf(props: PreviewOfPage) {
  const { t } = useTranslation();
  const { host, standing, openApp } = usePreviewStanding(props);
  const notice = previewNeedsApp(standing, host?.rights.write === true);
  return (
    <Banner
      layout="page"
      className="shrink-0"
      data-testid="preview-needs-app"
      action={
        "app" in notice ? (
          <Button variant="outline" size="sm" onClick={() => openApp(notice.app)}>
            {t("apps.openApp")}
          </Button>
        ) : undefined
      }
    >
      {t(notice.message)}
    </Banner>
  );
}

interface PageAppActionProps extends PreviewOfPage {
  /** The name the Page is read by, which Save as app proposes. */
  pageName: string;
}

/**
 * The actions about Apps in the header of a Page. Where the Page is the checkout of an App the
 * reader may write: Open app, the header's main action, and Save to draft beside it. Where no
 * App holds the Page: Save as app. The checkout of an App the reader may not write offers
 * nothing. Without the Apps of a workspace it is nothing and asks the instance nothing.
 */
export function PageAppAction(props: PageAppActionProps) {
  return appsOffered(useAppsHost()) ? <PageAppActionOf {...props} /> : null;
}

function PageAppActionOf({ conversationId, pageId, pageName }: PageAppActionProps) {
  const { t } = useTranslation();
  const { host, read, openApp } = usePreviewStanding({ conversationId, pageId });
  const choice = pageAppChoice(host, read);
  // The App the reader chose to put the Page into. Its dialog is held here: once the Page is
  // that App's, the header changes from Save as app to Save to draft under it.
  const [linking, setLinking] = useState<AppLinkCandidate>();
  return (
    <>
      {choice.kind === "update" ? (
        <>
          <PageHeaderAction
            primary
            label={t("apps.openApp")}
            icon={<RegistryIcon name="app" />}
            onClick={() => openApp(choice.app)}
          />
          <UpdateAppAction
            conversationId={conversationId}
            pageId={pageId}
            pageName={pageName}
            app={choice.app}
          />
        </>
      ) : choice.kind === "save" ? (
        <SaveAsAppAction
          conversationId={conversationId}
          pageId={pageId}
          proposedName={pageName}
          onLink={setLinking}
        />
      ) : null}
      {linking ? (
        <UpdateAppDialog
          conversationId={conversationId}
          pageId={pageId}
          pageName={pageName}
          app={linking}
          link={linking.page === "this" ? undefined : linking.page}
          onClose={() => setLinking(undefined)}
        />
      ) : null}
    </>
  );
}
