import { useState } from "react";
import { useAppFromPage, type AppFromPage, type AppLinkCandidate } from "./app-data";
import { useAppsHost, type AppsHost } from "./apps-host";
import { SaveAsAppAction } from "./save-as-app-dialog";
import { UpdateAppAction, UpdateAppDialog } from "./update-app-dialog";

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

interface PageAppActionProps {
  conversationId: string;
  pageId: string;
  /** The name the Page is read by, which Save as app proposes. */
  pageName: string;
}

/**
 * The action about Apps in the header of a Page: Update app where the Page was saved as an App
 * the reader may write, and Save as app everywhere else. Without the Apps of a workspace it is
 * nothing and asks the instance nothing.
 */
export function PageAppAction(props: PageAppActionProps) {
  const host = useAppsHost();
  return host?.enabled && host.workspace ? <PageAppActionOf host={host} {...props} /> : null;
}

function PageAppActionOf({
  host,
  conversationId,
  pageId,
  pageName
}: PageAppActionProps & { host: AppsHost }) {
  const read = useAppFromPage(conversationId, pageId, true);
  const choice = pageAppChoice(host, read);
  // The App the reader chose to put the Page into. Its dialog is held here: once the Page is
  // that App's, the header changes from Save as app to Update app under it.
  const [linking, setLinking] = useState<AppLinkCandidate>();
  return (
    <>
      {choice.kind === "update" ? (
        <UpdateAppAction
          conversationId={conversationId}
          pageId={pageId}
          pageName={pageName}
          app={choice.app}
        />
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
