import { FolderInput } from "lucide-react";
import { useEffect, useState } from "react";
import type { CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import { useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Dialog } from "../ui/dialog";
import {
  CollaborationWorkspaceAvatar,
  PersonalCollaborationWorkspaceAvatar
} from "./collaboration-workspace-avatar";
import { collaborationWorkspaceDisplayName } from "./collaboration-workspace-selector";

export function MoveConversationDialog({
  open,
  conversationTitle,
  collaborationWorkspaces,
  activeCollaborationWorkspaceId,
  userLabel,
  pending,
  errorMessage,
  onClose,
  onMove
}: {
  open: boolean;
  conversationTitle: string;
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  userLabel: string;
  pending: boolean;
  errorMessage: string | undefined;
  onClose(): void;
  onMove(collaborationWorkspaceId: string): void;
}) {
  const { t } = useTranslation();
  const [selectedCollaborationWorkspaceId, setSelectedCollaborationWorkspaceId] = useState<
    string | undefined
  >();
  const destinations = moveConversationDestinations(
    collaborationWorkspaces,
    activeCollaborationWorkspaceId
  );

  useEffect(() => {
    if (!open) {
      setSelectedCollaborationWorkspaceId(undefined);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      title={t("moveConversationTitle")}
      onClose={() => {
        if (!pending) {
          onClose();
        }
      }}
    >
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selectedCollaborationWorkspaceId || pending) {
            return;
          }
          onMove(selectedCollaborationWorkspaceId);
        }}
      >
        <p className="text-sm leading-6 text-muted-foreground">
          {t("moveConversationDescription", { title: conversationTitle })}
        </p>

        {destinations.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            {t("moveConversationNoDestinations")}
          </p>
        ) : (
          <fieldset className="grid gap-2" disabled={pending}>
            <legend className="pb-2 text-sm font-medium">
              {t("moveConversationDestinationLabel")}
            </legend>
            {destinations.map((collaborationWorkspace) => {
              const selected = selectedCollaborationWorkspaceId === collaborationWorkspace.id;
              return (
                <label
                  key={collaborationWorkspace.id}
                  data-testid="move-conversation-destination-row"
                  className={cn(
                    "grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2.5 rounded-md border p-3 transition-colors",
                    selected ? "border-ring bg-accent/50" : "hover:bg-accent/30"
                  )}
                >
                  <input
                    type="radio"
                    name="move-conversation-destination"
                    className="size-4 accent-[var(--primary)]"
                    checked={selected}
                    value={collaborationWorkspace.id}
                    onChange={() => setSelectedCollaborationWorkspaceId(collaborationWorkspace.id)}
                  />
                  {collaborationWorkspace.kind === "personal" ? (
                    <PersonalCollaborationWorkspaceAvatar label={userLabel} />
                  ) : (
                    <CollaborationWorkspaceAvatar
                      name={collaborationWorkspace.name}
                      emoji={collaborationWorkspace.emoji}
                      accentColor={collaborationWorkspace.accentColor}
                    />
                  )}
                  <span className="truncate text-sm font-medium">
                    {collaborationWorkspaceDisplayName(collaborationWorkspace, t)}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={pending || !selectedCollaborationWorkspaceId}>
            <FolderInput size={16} aria-hidden="true" />
            {pending ? t("moveConversationPending") : t("moveConversationSubmit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Every workspace the conversation does not already live in, Personal first and
 * the shared ones alphabetically, matching the selector menu's order.
 */
export function moveConversationDestinations(
  collaborationWorkspaces: CollaborationWorkspaceWithRole[],
  activeCollaborationWorkspaceId: string | undefined
): CollaborationWorkspaceWithRole[] {
  const candidates = collaborationWorkspaces.filter(
    (collaborationWorkspace) => collaborationWorkspace.id !== activeCollaborationWorkspaceId
  );
  const personalCollaborationWorkspaces = candidates.filter(
    (collaborationWorkspace) => collaborationWorkspace.kind === "personal"
  );
  const sharedCollaborationWorkspaces = candidates
    .filter((collaborationWorkspace) => collaborationWorkspace.kind === "shared")
    .sort((left, right) => left.name.localeCompare(right.name));
  return [...personalCollaborationWorkspaces, ...sharedCollaborationWorkspaces];
}
