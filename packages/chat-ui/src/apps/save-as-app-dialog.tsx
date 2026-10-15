import { LayoutGrid } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Field, InlineError, Input } from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useTranslation } from "../i18n";
import { apiErrorCode } from "../workspace-utils";
import { useAppWrites, type AppLinkCandidate } from "./app-data";
import { APP_ID_PATTERN, APP_NAME_MAX, appIdFromName, appRefusalText } from "./app-model";
import { useAppsHost } from "./apps-host";
import { PageHeaderAction } from "./page-header-action";

const FORM_ID = "save-as-app-form";

/**
 * Save as app, in the header of a Page that has no App the reader may write: for whoever may
 * write Apps in the workspace of the conversation, while the Apps module is on. Everywhere else
 * it is nothing, which is also what a Page shows outside a workspace shell. Saving makes the
 * draft of a new App and opens it. Where the id belongs to an App the reader may write, the
 * dialog offers to put the Page into that App, and hands the App to `onLink`.
 */
export function SaveAsAppAction({
  conversationId,
  pageId,
  pageName,
  onLink
}: {
  conversationId: string;
  pageId: string;
  /** The Page's title: the name the dialog proposes. */
  pageName: string;
  /** Takes over with an App the reader chose to put the Page into. Without it no App is offered. */
  onLink?: (app: AppLinkCandidate) => void;
}) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const [open, setOpen] = useState(false);
  if (!host?.enabled || !host.rights.write || !host.workspace) {
    return null;
  }
  const workspace = host.workspace;
  return (
    <>
      <PageHeaderAction
        label={t("apps.save")}
        icon={<LayoutGrid aria-hidden="true" />}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <SaveAsAppDialog
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          conversationId={conversationId}
          pageId={pageId}
          proposedName={pageName}
          onClose={() => setOpen(false)}
          onLink={
            onLink &&
            ((app) => {
              setOpen(false);
              onLink(app);
            })
          }
          onSaved={(app) => {
            setOpen(false);
            host.showRoute({ kind: "app-edit", collaborationWorkspaceId: workspace.id, app });
          }}
        />
      ) : null}
    </>
  );
}

/** The dialog with the request behind it. */
function SaveAsAppDialog({
  workspaceId,
  workspaceName,
  conversationId,
  pageId,
  proposedName,
  onClose,
  onLink,
  onSaved
}: {
  workspaceId: string;
  workspaceName: string;
  conversationId: string;
  pageId: string;
  proposedName: string;
  onClose(): void;
  onLink: ((app: AppLinkCandidate) => void) | undefined;
  onSaved(app: string): void;
}) {
  const { t } = useTranslation();
  const writes = useAppWrites(workspaceId);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveAsAppFailure>();
  return (
    <SaveAsAppDialogView
      workspaceName={workspaceName}
      proposedName={proposedName}
      saving={saving}
      failure={failure}
      onClose={onClose}
      onLink={onLink}
      onSave={({ id, name }) => {
        setSaving(true);
        setFailure(undefined);
        writes.saveFromPage({ conversationId, pageId, id, name }).then(
          (saved) => onSaved(saved.name),
          async (error: unknown) => {
            const refusal = appRefusalText(error);
            if (apiErrorCode(error) === "CONFLICT") {
              // The id is taken. An App the reader may write can take the Page instead.
              const taken = onLink
                ? await writes
                    .linkCandidate({ conversationId, pageId, app: id })
                    .catch(() => undefined)
                : undefined;
              setFailure(
                taken
                  ? {
                      field: "id",
                      message: t("apps.saveIdTakenWritable", { name: taken.title }),
                      taken
                    }
                  : { field: "id", message: t("apps.saveIdTaken") }
              );
            } else {
              setFailure({
                message: refusal ? t(refusal) : (instanceSentence(error) ?? t("apps.saveFailed"))
              });
            }
            setSaving(false);
          }
        );
      }}
    />
  );
}

/** Why a save was refused, and whether that is about the id. */
interface SaveAsAppFailure {
  field?: "id";
  message: string;
  /** The App that has the id, where the reader may write it. */
  taken?: AppLinkCandidate;
}

/**
 * The form of Save as app: the name people read, and the id, which follows the name until the
 * reader changes it. An App belongs to the one workspace it is saved in, so there is no scope
 * to choose.
 */
export function SaveAsAppDialogView({
  workspaceName,
  proposedName,
  saving,
  failure,
  onClose,
  onLink,
  onSave
}: {
  workspaceName: string;
  proposedName: string;
  saving: boolean;
  failure: SaveAsAppFailure | undefined;
  onClose(): void;
  /** Puts the Page into the App that has the id. */
  onLink?: ((app: AppLinkCandidate) => void) | undefined;
  onSave(app: { id: string; name: string }): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(proposedName.slice(0, APP_NAME_MAX));
  const [typedId, setTypedId] = useState<string>();
  const [checked, setChecked] = useState(false);
  const id = typedId ?? appIdFromName(name);
  const idValid = APP_ID_PATTERN.test(id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (name.trim() && idValid) {
      onSave({ id, name: name.trim() });
    }
  };

  return (
    <Dialog
      open
      size="sm"
      title={t("apps.save")}
      description={t("apps.saveBody", { workspace: workspaceName })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} loading={saving}>
            {t("apps.saveConfirm")}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="grid gap-4" onSubmit={submit}>
        <Field label={t("apps.saveName")} required>
          <Input
            autoFocus
            value={name}
            required
            maxLength={APP_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label={t("apps.saveId")}
          required
          hint={t("apps.saveIdHint")}
          error={
            failure?.field === "id"
              ? failure.message
              : checked && !idValid
                ? t("apps.saveIdInvalid")
                : undefined
          }
        >
          <Input
            value={id}
            required
            className="font-mono"
            onChange={(event) => setTypedId(event.target.value)}
          />
        </Field>
        {failure?.taken && onLink ? (
          <Button
            variant="outline"
            className="justify-self-start"
            disabled={saving}
            onClick={() => failure.taken && onLink(failure.taken)}
          >
            {t("apps.linkOffer", { name: failure.taken.title })}
          </Button>
        ) : null}
        {failure && failure.field === undefined ? (
          <InlineError>{failure.message}</InlineError>
        ) : null}
      </form>
    </Dialog>
  );
}
