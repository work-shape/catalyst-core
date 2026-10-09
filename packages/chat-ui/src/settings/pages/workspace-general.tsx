import { useEffect, useState } from "react";
import type { CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import {
  Banner,
  Button,
  ConfirmDialog,
  Field,
  Input,
  PageHeader,
  SaveBar,
  Section,
  Textarea
} from "@vivd-catalyst/ui";
import { useCollaborationWorkspaceMutations } from "../../api/workspace-mutations";
import {
  useCollaborationWorkspaceDeletionImpactQuery,
  useCollaborationWorkspaceMembersQuery
} from "../../api/workspace-queries";
import {
  resolveCollaborationWorkspaceAccentColor,
  type CollaborationWorkspaceAccentColor
} from "../../collaboration-workspace/collaboration-workspace-accent";
import {
  useCollaborationWorkspaceActionError,
  useCollaborationWorkspaceDeletionError
} from "../../collaboration-workspace/collaboration-workspace-action-error";
import { CollaborationWorkspaceAvatar } from "../../collaboration-workspace/collaboration-workspace-avatar";
import {
  CollaborationWorkspaceAccentField,
  CollaborationWorkspaceConversationVisibilityField,
  CollaborationWorkspaceEmojiField,
  CollaborationWorkspaceVisibilityField,
  type CollaborationWorkspaceVisibility,
  type ConversationVisibility
} from "../../collaboration-workspace/collaboration-workspace-fields";
import { canDeleteCollaborationWorkspace } from "../../collaboration-workspace/collaboration-workspace-roles";
import { DeleteCollaborationWorkspaceDialog } from "../../collaboration-workspace/delete-collaboration-workspace-dialog";
import { useTranslation } from "../../i18n";
import { useSettingsPage } from "../settings-page-context";

/** The longest name and description the server stores for a workspace, in characters. */
const WORKSPACE_NAME_MAX_CHARS = 120;
const WORKSPACE_DESCRIPTION_MAX_CHARS = 500;

/**
 * Workspace > General: what the shared workspace is called, who finds it, how it looks, and
 * the way to leave or delete it. The rail's switcher says which workspace this is.
 */
export function WorkspaceGeneralPage() {
  const { t } = useTranslation();
  const { workspace } = useSettingsPage();

  return (
    <>
      <PageHeader
        title={t("settings.general")}
        // A superadmin reaches every shared workspace; this one they manage from outside.
        description={
          workspace && workspace.membershipRole === null
            ? t("collaborationWorkspaceRoleSuperadminOnly")
            : undefined
        }
      />
      {/* Keyed by the workspace, so a switch in the rail starts a fresh form. */}
      {workspace ? <WorkspaceGeneral key={workspace.id} workspace={workspace} /> : null}
    </>
  );
}

function WorkspaceGeneral({ workspace }: { workspace: CollaborationWorkspaceWithRole }) {
  const { apiBaseUrl, authScope, client, user, onWorkspaceLeft, onWorkspaceDeleted } =
    useSettingsPage();
  const collaborationWorkspaceId = workspace.id;
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const membersQuery = useCollaborationWorkspaceMembersQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    enabled: true
  });
  const deletionImpactQuery = useCollaborationWorkspaceDeletionImpactQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    enabled: deleteOpen
  });
  const {
    updateCollaborationWorkspace,
    deleteCollaborationWorkspace,
    leaveCollaborationWorkspace
  } = useCollaborationWorkspaceMutations({ apiBaseUrl, authScope, client });
  const { errorMessage, clearError, reportError } = useCollaborationWorkspaceActionError();
  const deletionError = useCollaborationWorkspaceDeletionError();

  return (
    <>
      <WorkspaceGeneralView
        workspace={workspace}
        otherOwnerExists={(membersQuery.data ?? []).some(
          (member) => member.role === "owner" && member.userId !== user.id
        )}
        errorMessage={errorMessage}
        savePending={updateCollaborationWorkspace.isPending}
        saved={saved}
        leavePending={leaveCollaborationWorkspace.isPending}
        onEdit={() => setSaved(false)}
        onSave={(update) => {
          clearError();
          setSaved(false);
          updateCollaborationWorkspace.mutate(
            { collaborationWorkspaceId, update },
            {
              onSuccess: () => setSaved(true),
              onError: (error) => reportError("update", error)
            }
          );
        }}
        onLeave={() => {
          clearError();
          leaveCollaborationWorkspace.mutate(collaborationWorkspaceId, {
            onSuccess: onWorkspaceLeft,
            onError: (error) => reportError("leave", error)
          });
        }}
        onRequestDelete={() => {
          clearError();
          deletionError.clearError();
          setDeleteOpen(true);
        }}
      />
      <DeleteCollaborationWorkspaceDialog
        open={deleteOpen}
        collaborationWorkspaceName={workspace.name}
        deletionImpact={deletionImpactQuery.data}
        deletionImpactLoading={deletionImpactQuery.isPending}
        deletionImpactLoadFailed={Boolean(deletionImpactQuery.error)}
        pending={deleteCollaborationWorkspace.isPending}
        errorMessage={deletionError.errorMessage}
        nameErrorMessage={deletionError.nameErrorMessage}
        onClose={() => {
          deletionError.clearError();
          setDeleteOpen(false);
        }}
        onDelete={(confirmName) => {
          deletionError.clearError();
          deleteCollaborationWorkspace.mutate(
            { collaborationWorkspaceId, confirmName },
            {
              onSuccess: () => {
                setDeleteOpen(false);
                onWorkspaceDeleted(collaborationWorkspaceId);
              },
              onError: (error) => deletionError.reportError(error)
            }
          );
        }}
      />
    </>
  );
}

export interface WorkspaceGeneralValues {
  name: string;
  description: string | null;
  visibility: CollaborationWorkspaceVisibility;
  defaultConversationVisibility: ConversationVisibility;
  emoji: string | null;
  accentColor: CollaborationWorkspaceAccentColor;
}

/** The General form and the leave and delete actions, without the data behind them. */
export function WorkspaceGeneralView({
  workspace,
  otherOwnerExists,
  errorMessage,
  savePending,
  saved,
  leavePending,
  onEdit,
  onSave,
  onLeave,
  onRequestDelete
}: {
  workspace: CollaborationWorkspaceWithRole;
  /** Another member is an owner, so this owner may leave. */
  otherOwnerExists: boolean;
  errorMessage: string | undefined;
  savePending: boolean;
  /** True after a successful save, until the form changes again. */
  saved: boolean;
  leavePending: boolean;
  onEdit(): void;
  onSave(values: WorkspaceGeneralValues): void;
  onLeave(): void;
  onRequestDelete(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [emoji, setEmoji] = useState(workspace.emoji ?? "");
  const [visibility, setVisibility] = useState<CollaborationWorkspaceVisibility>(
    workspace.visibility
  );
  const [defaultConversationVisibility, setDefaultConversationVisibility] =
    useState<ConversationVisibility>(workspace.defaultConversationVisibility);
  const [accentColor, setAccentColor] = useState<CollaborationWorkspaceAccentColor>(() =>
    resolveCollaborationWorkspaceAccentColor(workspace)
  );
  const [leaveOpen, setLeaveOpen] = useState(false);

  // The form follows the stored workspace once a save comes back.
  useEffect(() => {
    setName(workspace.name);
    setDescription(workspace.description ?? "");
    setEmoji(workspace.emoji ?? "");
    setVisibility(workspace.visibility);
    setDefaultConversationVisibility(workspace.defaultConversationVisibility);
    setAccentColor(resolveCollaborationWorkspaceAccentColor(workspace));
  }, [workspace]);

  const trimmedName = name.trim();
  // A superadmin without a membership has nothing to leave.
  const isMember = workspace.membershipRole !== null;
  const canLeave = workspace.membershipRole !== "owner" || otherOwnerExists;
  const canDelete = canDeleteCollaborationWorkspace(workspace);

  function edit<Value>(set: (value: Value) => void) {
    return (value: Value) => {
      onEdit();
      set(value);
    };
  }

  function save() {
    if (!trimmedName || savePending) {
      return;
    }
    onSave({
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
      visibility,
      defaultConversationVisibility,
      emoji: emoji.trim() ? emoji.trim() : null,
      accentColor
    });
  }

  return (
    <>
      {errorMessage ? (
        <Banner tone="danger" className="mb-6">
          {errorMessage}
        </Banner>
      ) : null}
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Section layout="stacked" title={t("settings.workspaceDetails")}>
          <div className="grid gap-5">
            <Field
              label={t("collaborationWorkspaceNameLabel")}
              error={trimmedName ? undefined : t("collaborationWorkspaceNameRequired")}
              required
            >
              <Input
                value={name}
                maxLength={WORKSPACE_NAME_MAX_CHARS}
                disabled={savePending}
                onChange={(event) => edit(setName)(event.currentTarget.value)}
              />
            </Field>
            <Field
              label={t("collaborationWorkspaceDescriptionLabel")}
              hint={t("collaborationWorkspaceDescriptionHint")}
            >
              <Textarea
                value={description}
                maxLength={WORKSPACE_DESCRIPTION_MAX_CHARS}
                disabled={savePending}
                onChange={(event) => edit(setDescription)(event.currentTarget.value)}
              />
            </Field>
          </div>
        </Section>
        <Section layout="stacked" title={t("settings.workspaceAccess")}>
          <div className="grid gap-5">
            <CollaborationWorkspaceVisibilityField
              value={visibility}
              disabled={savePending}
              onChange={edit(setVisibility)}
            />
            <CollaborationWorkspaceConversationVisibilityField
              value={defaultConversationVisibility}
              disabled={savePending}
              onChange={edit(setDefaultConversationVisibility)}
            />
          </div>
        </Section>
        <Section
          layout="stacked"
          title={t("settings.appearance")}
          // The avatar previews the emoji and the colour before they are saved.
          action={
            <CollaborationWorkspaceAvatar
              name={trimmedName || workspace.name}
              emoji={emoji.trim() ? emoji.trim() : null}
              accentColor={accentColor}
              size="lg"
            />
          }
        >
          <div className="grid gap-5">
            <CollaborationWorkspaceEmojiField
              value={emoji}
              disabled={savePending}
              onChange={edit(setEmoji)}
            />
            <CollaborationWorkspaceAccentField
              value={accentColor}
              disabled={savePending}
              onChange={edit(setAccentColor)}
            />
          </div>
          <SaveBar
            className="pb-0"
            label={t("configSaveChanges")}
            saving={savePending}
            disabled={!trimmedName}
            saved={saved}
            savedLabel={t("collaborationWorkspaceSettingsSaved")}
          />
        </Section>
      </form>
      {isMember || canDelete ? (
        <Section
          layout="stacked"
          title={t("settings.workspaceLeaveOrDelete")}
          description={
            isMember && !canLeave ? t("collaborationWorkspaceErrorLastOwner") : undefined
          }
        >
          <div className="flex flex-wrap gap-2">
            {isMember ? (
              <Button
                variant="outline"
                disabled={!canLeave || leavePending}
                onClick={() => setLeaveOpen(true)}
              >
                {t("collaborationWorkspaceLeave")}
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                variant="outline"
                data-testid="collaboration-workspace-delete-trigger"
                onClick={onRequestDelete}
              >
                {t("collaborationWorkspaceDelete")}
              </Button>
            ) : null}
          </div>
        </Section>
      ) : null}
      {leaveOpen ? (
        <ConfirmDialog
          open
          title={t("collaborationWorkspaceLeaveTitle")}
          confirmLabel={t("collaborationWorkspaceLeaveConfirm")}
          loading={leavePending}
          onConfirm={() => {
            setLeaveOpen(false);
            onLeave();
          }}
          onClose={() => setLeaveOpen(false)}
        >
          {t("collaborationWorkspaceLeaveDescription", { name: workspace.name })}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
