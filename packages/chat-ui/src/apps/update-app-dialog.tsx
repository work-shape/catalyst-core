import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, FormNotice, InlineError } from "@vivd-catalyst/ui";
import { instanceSentence, PendingApprovalError } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import { apiErrorCode } from "../workspace-utils";
import { useAppWrites, type AppFromPage, type AppLinkCandidate } from "./app-data";
import { appRefusalText } from "./app-model";
import { useAppsHost } from "./apps-host";
import { PageHeaderAction } from "./page-header-action";

/**
 * Update app, in the header of a Page whose App the reader may write. It writes the Page as it
 * is now into the draft of that App and publishes nothing.
 */
export function UpdateAppAction({
  conversationId,
  pageId,
  pageName,
  app
}: {
  conversationId: string;
  pageId: string;
  /** The Page's title, which the App's name may differ from. */
  pageName?: string | undefined;
  app: AppFromPage;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeaderAction
        label={t("apps.update")}
        icon={<RefreshCw aria-hidden="true" />}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <UpdateAppDialog
          conversationId={conversationId}
          pageId={pageId}
          pageName={pageName}
          app={app}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** How far an update is: asked for, on its way, made, or refused. */
export type UpdateAppPhase = "idle" | "working" | "done" | "failed";

/** The Page an App is updated from before this Page is put into it. */
export type AppLinkedPage = Exclude<AppLinkCandidate["page"], "this">;

/**
 * The dialog with the request behind it. With `link` the App is not this Page's yet: the
 * update makes it so, and says what that replaces.
 */
export function UpdateAppDialog({
  conversationId,
  pageId,
  pageName,
  app,
  link,
  onClose
}: {
  conversationId: string;
  pageId: string;
  pageName?: string | undefined;
  app: Pick<AppFromPage, "name" | "title" | "workspaceId" | "draftRevision"> & {
    draftFromPage?: boolean;
  };
  link?: AppLinkedPage | undefined;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const writes = useAppWrites(app.workspaceId);
  const [phase, setPhase] = useState<UpdateAppPhase>("idle");
  const [failure, setFailure] = useState<string>();
  // The draft moved under an update the reader asked for: the next one has to be meant.
  const [moved, setMoved] = useState(false);
  // An App the header does not read again is asked for its revision after a refusal.
  const [linkRevision, setLinkRevision] = useState(app.draftRevision);

  const update = () => {
    setPhase("working");
    setFailure(undefined);
    writes
      .updateFromPage({
        conversationId,
        pageId,
        app: app.name,
        expectedRevision: link ? linkRevision : app.draftRevision,
        ...(link ? { link: true } : {})
      })
      .then(
        () => setPhase("done"),
        async (error: unknown) => {
          if (apiErrorCode(error) === "REVISION_CONFLICT") {
            // The write dropped what was read of the App, so `app` arrives at the new revision.
            if (link) {
              const now = await writes
                .linkCandidate({ conversationId, pageId, app: app.name })
                .catch(() => undefined);
              setLinkRevision(now?.draftRevision ?? linkRevision);
            }
            setMoved(true);
            setPhase("idle");
            return;
          }
          const refusal = appRefusalText(error);
          setFailure(
            error instanceof PendingApprovalError
              ? t("apps.publishPending")
              : refusal
                ? t(refusal)
                : (instanceSentence(error) ?? t("apps.updateFailed"))
          );
          setPhase("failed");
        }
      );
  };

  return (
    <UpdateAppDialogView
      name={app.title}
      pageName={pageName}
      phase={phase}
      link={link}
      changedElsewhere={moved || (!link && app.draftFromPage === false)}
      failure={failure}
      onClose={onClose}
      onUpdate={update}
      onOpen={() => {
        onClose();
        host?.showRoute({
          kind: "app-edit",
          collaborationWorkspaceId: app.workspaceId,
          app: app.name
        });
      }}
    />
  );
}

/**
 * What Update app asks and answers, in one place: what the update does and to which App before
 * it, and after it that the draft has the Page and where to publish it. A draft that is not
 * this Page's copy is replaced only by a second, differently named button: one that was
 * changed somewhere else, and the draft of an App the Page is put into for the first time.
 */
export function UpdateAppDialogView({
  name,
  pageName,
  phase,
  link,
  changedElsewhere,
  failure,
  onClose,
  onUpdate,
  onOpen
}: {
  /** What people read as the App's name. */
  name: string;
  /** The Page's title. The done state says that the App keeps its own where they differ. */
  pageName?: string | undefined;
  phase: UpdateAppPhase;
  /** The App is not this Page's yet, and which Page it is updated from now. */
  link?: AppLinkedPage | undefined;
  /** The draft is not the copy of this Page it was after the last update. */
  changedElsewhere: boolean;
  failure: string | undefined;
  onClose(): void;
  onUpdate(): void;
  /** Opens the draft of the App. */
  onOpen(): void;
}) {
  const { t } = useTranslation();
  if (phase === "done") {
    return (
      <Dialog
        open
        size="sm"
        title={t("apps.updateDoneTitle", { name })}
        onClose={onClose}
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              {t("close")}
            </Button>
            <Button onClick={onOpen}>{t("apps.openDraft")}</Button>
          </>
        }
      >
        <div className="grid gap-3">
          <FormNotice tone="success">{t("apps.updateDone")}</FormNotice>
          {pageName !== undefined && pageName.trim() !== name.trim() ? (
            <p className="text-body text-muted-foreground">
              {t("apps.updateKeptName", { name, page: pageName })}
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }
  const working = phase === "working";
  const replaces = link !== undefined || changedElsewhere;
  return (
    <Dialog
      open
      size="sm"
      title={t(link ? "apps.linkTitle" : "apps.updateTitle", { name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={working} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant={replaces ? "danger" : "primary"} loading={working} onClick={onUpdate}>
            {t(replaces ? "apps.updateReplace" : "apps.updateConfirm")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {link ? (
          <>
            <p className="text-body">{t("apps.linkBody")}</p>
            {link === "none" ? null : (
              <p className="text-body">
                {t(
                  link === "other_conversation"
                    ? "apps.linkOtherConversation"
                    : "apps.linkOtherPage"
                )}
              </p>
            )}
          </>
        ) : (
          <p className="text-body text-muted-foreground">{t("apps.updateBody")}</p>
        )}
        {changedElsewhere ? (
          <p className="text-body">{t(link ? "apps.linkMoved" : "apps.updateChanged")}</p>
        ) : null}
        {failure ? <InlineError>{failure}</InlineError> : null}
      </div>
    </Dialog>
  );
}
