import { useAppFromPage, type AppFromPage } from "./app-data";
import { useAppsHost, type AppsHost } from "./apps-host";
import { SaveAsAppAction } from "./save-as-app-dialog";
import { UpdateAppAction } from "./update-app-dialog";

/** What the header of a Page offers about Apps. */
export type PageAppChoice =
  { kind: "none" } | { kind: "save" } | { kind: "update"; app: AppFromPage };

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
 * The action about Apps in the header of a Page: Update app where the Page was saved as an App
 * the reader may write, and Save as app everywhere else.
 */
export function PageAppAction({
  conversationId,
  pageId,
  pageName
}: {
  conversationId: string;
  pageId: string;
  /** The Page's title: the name Save as app proposes. */
  pageName: string;
}) {
  const host = useAppsHost();
  const read = useAppFromPage(
    conversationId,
    pageId,
    host?.enabled === true && host.workspace !== undefined
  );
  const choice = pageAppChoice(host, read);
  if (choice.kind === "update") {
    return <UpdateAppAction conversationId={conversationId} pageId={pageId} app={choice.app} />;
  }
  return choice.kind === "save" ? (
    <SaveAsAppAction conversationId={conversationId} pageId={pageId} pageName={pageName} />
  ) : null;
}
