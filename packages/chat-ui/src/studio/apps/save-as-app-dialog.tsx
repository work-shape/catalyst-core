import { LayoutGrid } from "lucide-react";
import { useState, type FormEvent } from "react";
import { appIdFromName } from "@work-shape/catalyst-core";
import { Button, Dialog, Field, InlineError, Input } from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useTranslation } from "../../shared/i18n";
import { apiErrorCode } from "../../shared/workspace-utils";
import { useAppWrites, type AppLinkCandidate } from "./app-data";
import { APP_NAME_MAX, appRefusalText } from "./app-model";
import { useAppsHost } from "./apps-host";
import { PageHeaderAction } from "./page-header-action";

const FORM_ID = "save-as-app-form";

/**
 * Save as app, in the header of a Page that has no App the reader may write: for whoever may
 * write Apps in the workspace of the conversation, while the Apps module is on. Everywhere else
 * it is nothing, which is also what a Page shows outside a workspace shell. Saving makes the
 * draft of a new App and opens it. Where the name gives the id of an App the reader may write,
 * the dialog offers to put the Page into that App, and hands the App to `onLink`.
 */
export function SaveAsAppAction({
  conversationId,
  pageId,
  proposedName,
  onLink
}: {
  conversationId: string;
  pageId: string;
  /** The name the dialog proposes. */
  proposedName: string;
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
          proposedName={proposedName}
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
              // The id the name gives is taken. An App the reader may write can take the Page
              // instead.
              const taken = onLink
                ? await writes
                    .linkCandidate({ conversationId, pageId, app: id })
                    .catch(() => undefined)
                : undefined;
              setFailure(
                taken
                  ? {
                      name,
                      field: "name",
                      message: t("apps.saveNameTakenWritable", { name: taken.title }),
                      taken
                    }
                  : { name, field: "name", message: t("apps.saveNameTaken") }
              );
            } else {
              setFailure({
                name,
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

/** Why a save was refused, and whether that is about the name. */
interface SaveAsAppFailure {
  /** The name the save was sent with. The refusal stands only while the field still holds it. */
  name: string;
  field?: "name";
  message: string;
  /** The App that has the id, where the reader may write it. */
  taken?: AppLinkCandidate;
}

/**
 * What Save as app sends for a typed name: the name without its outer spaces, and the id the
 * agent's `app.save` makes of it. Nothing for a name of only spaces.
 */
export function saveAsAppInput(name: string): { id: string; name: string } | undefined {
  const named = name.trim();
  return named === "" ? undefined : { id: appIdFromName(named), name: named };
}

/**
 * The form of Save as app: the name people read, and nothing else. The id is made from the
 * name as the agent's `app.save` makes it. An App belongs to the one workspace it is saved in,
 * so there is no scope to choose.
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
  /** Puts the Page into the App that has the id the name gives. */
  onLink?: ((app: AppLinkCandidate) => void) | undefined;
  onSave(app: { id: string; name: string }): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(proposedName.slice(0, APP_NAME_MAX));
  // A refusal of another name says nothing about this one, and its App may be another.
  const refused = failure?.name === name.trim() ? failure : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const app = saveAsAppInput(name);
    if (app) {
      onSave(app);
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
        <Field
          label={t("apps.saveName")}
          required
          error={refused?.field === "name" ? refused.message : undefined}
        >
          <Input
            autoFocus
            value={name}
            required
            maxLength={APP_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {refused?.taken && onLink ? (
          <Button
            variant="outline"
            className="justify-self-start"
            disabled={saving}
            onClick={() => refused.taken && onLink(refused.taken)}
          >
            {t("apps.linkOffer", { name: refused.taken.title })}
          </Button>
        ) : null}
        {refused && refused.field === undefined ? (
          <InlineError>{refused.message}</InlineError>
        ) : null}
      </form>
    </Dialog>
  );
}
