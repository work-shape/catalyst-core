import type { CollaborationWorkspaceDirectoryItem } from "@vivd-catalyst/api-client";
import { Badge, Button, Dialog } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { CollaborationWorkspaceAvatar } from "./collaboration-workspace-avatar";
import {
  CollaborationWorkspaceDialogFooter,
  CollaborationWorkspaceDialogScrollBody
} from "./collaboration-workspace-dialog-chrome";

export function BrowseCollaborationWorkspacesDialog({
  open,
  collaborationWorkspaces,
  loading,
  loadFailed,
  errorMessage,
  pendingCollaborationWorkspaceId,
  onRequestAccess,
  onClose
}: {
  open: boolean;
  collaborationWorkspaces: CollaborationWorkspaceDirectoryItem[];
  loading: boolean;
  loadFailed: boolean;
  errorMessage: string | undefined;
  pendingCollaborationWorkspaceId: string | undefined;
  onRequestAccess(collaborationWorkspaceId: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      title={t("collaborationWorkspaceBrowseTitle")}
      className="chat-scrollbar"
      onClose={onClose}
    >
      {/*
        Same chrome as the other workspace dialogs: a pinned intro, the
        directory scrolling between two rules, and a pinned Close.
      */}
      <div className="-m-5 grid">
        <p className="border-b px-5 py-4 text-sm leading-6 text-muted-foreground">
          {t("collaborationWorkspaceBrowseDescription")}
        </p>

        <CollaborationWorkspaceDialogScrollBody className="max-h-[clamp(20rem,68vh,44rem)]">
          {loadFailed ? (
            <p className="text-sm text-destructive">
              {t("collaborationWorkspaceDirectoryLoadFailed")}
            </p>
          ) : loading ? (
            <p className="text-sm text-muted-foreground">{t("collaborationWorkspaceLoading")}</p>
          ) : collaborationWorkspaces.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              {t("collaborationWorkspaceDirectoryEmpty")}
            </p>
          ) : (
            <ul className="grid gap-2">
              {collaborationWorkspaces.map((collaborationWorkspace) => (
                <li
                  key={collaborationWorkspace.id}
                  data-testid="collaboration-workspace-directory-row"
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border p-3"
                >
                  <CollaborationWorkspaceAvatar
                    name={collaborationWorkspace.name}
                    emoji={collaborationWorkspace.emoji}
                    accentColor={collaborationWorkspace.accentColor}
                    size="lg"
                  />
                  <div className="grid min-w-0 gap-1">
                    <span className="truncate text-sm font-medium">
                      {collaborationWorkspace.name}
                    </span>
                    <span className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                      {collaborationWorkspace.description?.trim() ||
                        t("collaborationWorkspaceNoDescription")}
                    </span>
                  </div>
                  <DirectoryAction
                    accessState={collaborationWorkspace.accessState}
                    pending={pendingCollaborationWorkspaceId === collaborationWorkspace.id}
                    onRequestAccess={() => onRequestAccess(collaborationWorkspace.id)}
                  />
                </li>
              ))}
            </ul>
          )}

          {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        </CollaborationWorkspaceDialogScrollBody>

        <CollaborationWorkspaceDialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </CollaborationWorkspaceDialogFooter>
      </div>
    </Dialog>
  );
}

function DirectoryAction({
  accessState,
  pending,
  onRequestAccess
}: {
  accessState: CollaborationWorkspaceDirectoryItem["accessState"];
  pending: boolean;
  onRequestAccess(): void;
}) {
  const { t } = useTranslation();

  if (accessState === "member") {
    return <Badge>{t("collaborationWorkspaceRoleMember")}</Badge>;
  }
  if (accessState === "request_pending") {
    return <Badge appearance="outline">{t("collaborationWorkspaceRequestPending")}</Badge>;
  }
  return (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onRequestAccess}>
      {t("collaborationWorkspaceRequestAccess")}
    </Button>
  );
}
