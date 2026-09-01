import type { CollaborationWorkspaceDirectoryItem } from "@vivd-catalyst/api-client";
import { useTranslation } from "../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { CollaborationWorkspaceAvatar } from "./collaboration-workspace-avatar";

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
    <Dialog open={open} title={t("collaborationWorkspaceBrowseTitle")} onClose={onClose}>
      <div className="grid gap-4">
        <p className="text-sm leading-6 text-muted-foreground">
          {t("collaborationWorkspaceBrowseDescription")}
        </p>

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

        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
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
    return <Badge variant="secondary">{t("collaborationWorkspaceRoleMember")}</Badge>;
  }
  if (accessState === "request_pending") {
    return <Badge variant="outline">{t("collaborationWorkspaceRequestPending")}</Badge>;
  }
  return (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onRequestAccess}>
      {t("collaborationWorkspaceRequestAccess")}
    </Button>
  );
}
