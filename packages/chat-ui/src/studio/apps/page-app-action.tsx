import { useState } from "react";
import { Banner, Button, RegistryIcon } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { useAppFromPage, type AppFromPage, type AppLinkCandidate } from "./app-data";
import { useAppsHost, type AppsHost } from "./apps-host";
import { PageHeaderAction } from "./page-header-action";
import { SaveAsAppAction } from "./save-as-app-dialog";
import { UpdateAppAction, UpdateAppDialog } from "./update-app-dialog";

/** What the header of a Page offers about Apps. */
type PageAppChoice = { kind: "none" } | { kind: "save" } | { kind: "update"; app: AppFromPage };

/**
 * Which of the two the header of a Page offers. A Page whose App the reader may write offers
 * the update of that App, whatever the reader may do in the open workspace. Every other Page
 * offers Save as app to whoever may write Apps there. Until the instance said whether the Page
 * has an App it offers neither, so one action never turns into the other under the pointer.
 */
export function pageAppChoice(
  host: Pick<AppsHost, "enabled" | "rights" | "workspace"> | undefined,
  read: { app: AppFromPage | undefined; settled: boolean }
): PageAppChoice {
  if (!host?.enabled || !host.workspace || !read.settled) {
    return { kind: "none" };
  }
  if (read.app) {
    return { kind: "update", app: read.app };
  }
  return host.rights.write ? { kind: "save" } : { kind: "none" };
}

/**
 * What a preview is (PREVIEW-1): a folder no App holds, or the checkout of an App, which looks
 * like the App but reaches no Data Store and runs no Workflow of it. `unknown` until the
 * instance said, and where no Apps are offered.
 */
type PreviewStanding =
  { kind: "unknown" } | { kind: "unsaved" } | { kind: "app"; app: AppFromPage };

export function previewStanding(
  host: Pick<AppsHost, "enabled" | "workspace"> | undefined,
  read: { app: AppFromPage | undefined; settled: boolean }
): PreviewStanding {
  if (!host?.enabled || !host.workspace || !read.settled) {
    return { kind: "unknown" };
  }
  return read.app ? { kind: "app", app: read.app } : { kind: "unsaved" };
}

/** The line under the name of a preview that says what it is, by its standing. */
export function previewStateLine(
  standing: PreviewStanding,
  t: TranslationContextValue["t"]
): string | undefined {
  return standing.kind === "app"
    ? t("pages.stateOfApp", { app: standing.app.title })
    : standing.kind === "unsaved"
      ? t("pages.stateUnsaved")
      : undefined;
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

function PreviewNeedsAppNoticeOf(props: PreviewOfPage) {
  const { t } = useTranslation();
  const { standing, openApp } = usePreviewStanding(props);
  return (
    <Banner
      layout="page"
      className="shrink-0"
      data-testid="preview-needs-app"
      action={
        standing.kind === "app" ? (
          <Button variant="outline" size="sm" onClick={() => openApp(standing.app)}>
            {t("apps.openApp")}
          </Button>
        ) : undefined
      }
    >
      {t(standing.kind === "app" ? "pages.needsApp" : "pages.needsAppUnsaved")}
    </Banner>
  );
}

interface PageAppActionProps extends PreviewOfPage {
  /** The name the Page is read by, which Save as app proposes. */
  pageName: string;
}

/**
 * The actions about Apps in the header of a Page. Where the Page is an App's checkout: Open
 * app, the header's main action, and Save to draft beside it. Everywhere else Save as app.
 * Without the Apps of a workspace it is nothing and asks the instance nothing.
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
