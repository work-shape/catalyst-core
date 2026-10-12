import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, FormNotice, InlineError } from "@vivd-catalyst/ui";
import { instanceSentence, PendingApprovalError } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import { apiErrorCode } from "../workspace-utils";
import { useAppWrites, type AppFromPage } from "./app-data";
import { appRefusalText } from "./app-model";
import { useAppsHost } from "./apps-host";
import { PageHeaderAction } from "./page-header-action";

/**
 * Update app, in the header of a Page that was saved as an App the reader may write. It writes
 * the Page as it is now into the draft of that App and publishes nothing.
 */
export function UpdateAppAction({
  conversationId,
  pageId,
  app
}: {
  conversationId: string;
  pageId: string;
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
          app={app}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** How far an update is: asked for, on its way, made, or refused. */
export type UpdateAppPhase = "idle" | "working" | "done" | "failed";

/** The dialog with the request behind it. */
function UpdateAppDialog({
  conversationId,
  pageId,
  app,
  onClose
}: {
  conversationId: string;
  pageId: string;
  app: AppFromPage;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const writes = useAppWrites(app.workspaceId);
  const [phase, setPhase] = useState<UpdateAppPhase>("idle");
  const [failure, setFailure] = useState<string>();
  // The draft moved under an update the reader asked for: the next one has to be meant.
  const [moved, setMoved] = useState(false);

  const update = () => {
    setPhase("working");
    setFailure(undefined);
    writes
      .updateFromPage({
        conversationId,
        pageId,
        app: app.name,
        expectedRevision: app.draftRevision
      })
      .then(
        () => setPhase("done"),
        (error: unknown) => {
          if (apiErrorCode(error) === "REVISION_CONFLICT") {
            // The write dropped what was read of the App, so `app` arrives at the new revision.
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
      phase={phase}
      changedElsewhere={moved || !app.draftFromPage}
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
 * it, and after it that the draft has the Page and where to publish it. A draft that was
 * changed somewhere else is replaced only by a second, differently named button.
 */
export function UpdateAppDialogView({
  name,
  phase,
  changedElsewhere,
  failure,
  onClose,
  onUpdate,
  onOpen
}: {
  /** What people read as the App's name. */
  name: string;
  phase: UpdateAppPhase;
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
            <Button onClick={onOpen}>{t("apps.updateOpen")}</Button>
          </>
        }
      >
        <FormNotice tone="success">{t("apps.updateDone")}</FormNotice>
      </Dialog>
    );
  }
  const working = phase === "working";
  return (
    <Dialog
      open
      size="sm"
      title={t("apps.updateTitle", { name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={working} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant={changedElsewhere ? "danger" : "primary"}
            loading={working}
            onClick={onUpdate}
          >
            {t(changedElsewhere ? "apps.updateReplace" : "apps.updateConfirm")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-body text-muted-foreground">{t("apps.updateBody")}</p>
        {changedElsewhere ? <p className="text-body">{t("apps.updateChanged")}</p> : null}
        {failure ? <InlineError>{failure}</InlineError> : null}
      </div>
    </Dialog>
  );
}
