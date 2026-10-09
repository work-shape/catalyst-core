import { FolderInput } from "lucide-react";
import { useEffect, useState } from "react";
import type { CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import { Button, cn, Dialog, RadioGroup } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import {
  CollaborationWorkspaceAvatar,
  PersonalCollaborationWorkspaceAvatar
} from "./collaboration-workspace-avatar";
import type { ConversationVisibility } from "./collaboration-workspace-fields";
import { collaborationWorkspaceDisplayName } from "./collaboration-workspace-selector";

export function MoveConversationDialog({
  open,
  conversationTitle,
  conversationVisibility,
  movedByCreator,
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
  conversationVisibility: ConversationVisibility;
  /** Only the creator of a conversation may keep or make it private. */
  movedByCreator: boolean;
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  userLabel: string;
  pending: boolean;
  errorMessage: string | undefined;
  onClose(): void;
  /** `visibility` is absent for a Personal Workspace, which has no such choice. */
  onMove(collaborationWorkspaceId: string, visibility?: ConversationVisibility): void;
}) {
  const { t } = useTranslation();
  const [selectedCollaborationWorkspaceId, setSelectedCollaborationWorkspaceId] = useState<
    string | undefined
  >();
  // Undefined until the creator picks one, so each destination starts from the
  // visibility the server would apply on its own.
  const [chosenVisibility, setChosenVisibility] = useState<ConversationVisibility | undefined>();
  const destinations = moveConversationDestinations(
    collaborationWorkspaces,
    activeCollaborationWorkspaceId
  );

  const destination = destinations.find(
    (collaborationWorkspace) => collaborationWorkspace.id === selectedCollaborationWorkspaceId
  );
  const sharedDestination = destination?.kind === "shared" ? destination : undefined;
  const visibility = sharedDestination
    ? (chosenVisibility ??
      movedConversationVisibility({
        conversationVisibility,
        movedByCreator,
        destinationDefaultConversationVisibility: sharedDestination.defaultConversationVisibility
      }))
    : undefined;

  useEffect(() => {
    if (!open) {
      setSelectedCollaborationWorkspaceId(undefined);
      setChosenVisibility(undefined);
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
          onMove(selectedCollaborationWorkspaceId, visibility);
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
                    onChange={() => {
                      setSelectedCollaborationWorkspaceId(collaborationWorkspace.id);
                      setChosenVisibility(undefined);
                    }}
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

        {sharedDestination && visibility ? (
          <MoveConversationVisibility
            destinationName={sharedDestination.name}
            destinationDefaultConversationVisibility={
              sharedDestination.defaultConversationVisibility
            }
            visibility={visibility}
            movedByCreator={movedByCreator}
            disabled={pending}
            onChange={setChosenVisibility}
          />
        ) : null}

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
 * Who can open the conversation once it sits in a Shared Workspace. Its creator
 * chooses; anyone else can only move it as visible to the workspace, which is
 * spelled out where the destination would otherwise have made it private.
 */
export function MoveConversationVisibility({
  destinationName,
  destinationDefaultConversationVisibility,
  visibility,
  movedByCreator,
  disabled,
  onChange
}: {
  destinationName: string;
  destinationDefaultConversationVisibility: ConversationVisibility;
  visibility: ConversationVisibility;
  movedByCreator: boolean;
  disabled?: boolean;
  onChange(visibility: ConversationVisibility): void;
}) {
  const { t } = useTranslation();

  if (!movedByCreator) {
    return (
      <p className="text-sm leading-6 text-muted-foreground" data-testid="move-conversation-note">
        {t("moveConversationVisibilityWorkspaceHint", { name: destinationName })}
        {destinationDefaultConversationVisibility === "private"
          ? ` ${t("moveConversationVisibilityCreatorOnly")}`
          : null}
      </p>
    );
  }

  return (
    <RadioGroup
      name="move-conversation-visibility"
      label={t("moveConversationVisibilityLabel")}
      value={visibility}
      disabled={disabled}
      options={[
        {
          value: "workspace",
          label: t("collaborationWorkspaceConversationVisibilityWorkspace"),
          description: t("moveConversationVisibilityWorkspaceHint", { name: destinationName })
        },
        {
          value: "private",
          label: t("moveConversationVisibilityPrivate"),
          description: t("moveConversationVisibilityPrivateHint")
        }
      ]}
      onValueChange={onChange}
    />
  );
}

/**
 * The visibility a move into a Shared Workspace starts from. It mirrors the
 * server rule (a private conversation stays private, anything else takes the
 * destination default) with one difference: someone who is not the creator
 * always moves it as visible to the workspace, because the server rejects a
 * private result for them.
 */
export function movedConversationVisibility(input: {
  conversationVisibility: ConversationVisibility;
  movedByCreator: boolean;
  destinationDefaultConversationVisibility: ConversationVisibility;
}): ConversationVisibility {
  if (!input.movedByCreator) {
    return "workspace";
  }
  return input.conversationVisibility === "private"
    ? "private"
    : input.destinationDefaultConversationVisibility;
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
