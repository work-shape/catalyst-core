import { FolderInput, Lock, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  CollaborationWorkspaceWithRole,
  ProjectAudienceView,
  ProjectDeletionConversationsView,
  ProjectImpactView,
  ProjectView
} from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  EmptyState,
  FormNotice,
  RadioGroup,
  SkeletonList
} from "@work-shape/catalyst-ui";
import {
  useDeleteProjectMutation,
  useMoveProjectMutation,
  useProjectImpactQuery,
  useSetProjectAudienceMutation
} from "../../shared/api/projects";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { apiErrorCode, apiErrorReason } from "../../shared/workspace-utils";

type Translate = TranslationContextValue["t"];

// A whole project (PRJ-6): the "…" menu of its page and the three dialogs it opens. Each
// dialog reads what the change touches when it opens, and says it before the change.

/** A workspace of the person, as the project page names it. */
export interface ProjectSettingsWorkspace {
  id: string;
  /** Its name as the interface shows it; a Personal Workspace's is its owner's. */
  name: string;
  kind: CollaborationWorkspaceWithRole["kind"];
}

export type ProjectSetting = "audience" | "move" | "delete";

/**
 * The items of the project page's "…" menu. Only the creator changes who sees the project, and
 * only in a Shared Workspace; a move needs another workspace of the person.
 */
export function ProjectSettingsMenu({
  project,
  workspace,
  workspaces,
  currentUserId,
  onOpen
}: {
  project: ProjectView;
  workspace: ProjectSettingsWorkspace;
  workspaces: readonly ProjectSettingsWorkspace[];
  currentUserId: string | undefined;
  onOpen(setting: ProjectSetting): void;
}) {
  const { t } = useTranslation();
  const audience =
    workspace.kind === "shared" && currentUserId !== undefined
      ? project.createdByUserId === currentUserId
      : false;
  const elsewhere = workspaces.some((choice) => choice.id !== workspace.id);
  return (
    <>
      {audience ? (
        <DropdownMenuItem
          icon={
            project.audience === "private" ? (
              <Users aria-hidden="true" />
            ) : (
              <Lock aria-hidden="true" />
            )
          }
          onSelect={() => onOpen("audience")}
        >
          <span data-testid="project-menu-audience">
            {project.audience === "private"
              ? t("projectSettings.share")
              : t("projectSettings.makePrivate")}
          </span>
        </DropdownMenuItem>
      ) : null}
      {elsewhere ? (
        <DropdownMenuItem icon={<FolderInput aria-hidden="true" />} onSelect={() => onOpen("move")}>
          <span data-testid="project-menu-move">{t("projectSettings.moveToWorkspace")}</span>
        </DropdownMenuItem>
      ) : null}
      {audience || elsewhere ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        icon={<Trash2 aria-hidden="true" />}
        tone="danger"
        onSelect={() => onOpen("delete")}
      >
        <span data-testid="project-menu-delete">{t("projectSettings.delete")}</span>
      </DropdownMenuItem>
    </>
  );
}

/** The dialog the menu opened, for the project on the page. */
export function ProjectSettingsDialogs({
  open,
  project,
  workspace,
  workspaces,
  onClose,
  onMoved,
  onDeleted
}: {
  open: ProjectSetting | undefined;
  project: ProjectView;
  workspace: ProjectSettingsWorkspace;
  workspaces: readonly ProjectSettingsWorkspace[];
  onClose(): void;
  onMoved(project: ProjectView): void;
  onDeleted(): void;
}) {
  const impact = useProjectImpactQuery(project.id, open !== undefined);
  const shared = {
    project,
    workspace,
    impact: impact.data,
    impactFailed: impact.isError,
    onClose
  };
  return (
    <>
      <AudienceDialog open={open === "audience"} {...shared} />
      <MoveDialog open={open === "move"} {...shared} workspaces={workspaces} onMoved={onMoved} />
      <DeleteDialog open={open === "delete"} {...shared} onDeleted={onDeleted} />
    </>
  );
}

interface DialogProps {
  open: boolean;
  project: ProjectView;
  workspace: ProjectSettingsWorkspace;
  /** Undefined while it is read. */
  impact: ProjectImpactView | undefined;
  impactFailed: boolean;
  onClose(): void;
}

function count(t: Translate, kind: "chats" | "files", value: number): string {
  if (value === 1)
    return t(kind === "chats" ? "projectSettings.chatsOne" : "projectSettings.filesOne");
  return t(kind === "chats" ? "projectSettings.chats" : "projectSettings.files", {
    count: String(value)
  });
}

/** The refusal in the person's words; the server names the reason. */
function failure(t: Translate, error: unknown): string {
  switch (apiErrorReason(error)) {
    case "project_conversations_stay_private":
      return t("projectSettings.stayPrivate");
    case "project_files_stay_private":
      return t("projectSettings.filesStayPrivate");
    case "project_holds_others_conversations":
      return t("projectSettings.othersChats");
    case "project_move_member_only":
      return t("projectSettings.memberOnly");
    case "project_audience_changed":
      return t("projectSettings.changed");
    default:
      break;
  }
  switch (apiErrorCode(error)) {
    case "CONFLICT":
      return t("projectSettings.busy");
    case "FORBIDDEN":
      return t("projectSettings.deleteChatsOff");
    default:
      return t("projectSettings.failed");
  }
}

function ImpactState({ impact, failed }: { impact: unknown; failed: boolean }) {
  const { t } = useTranslation();
  if (failed) return <FormNotice tone="error">{t("projectSettings.loadFailed")}</FormNotice>;
  return impact === undefined ? <SkeletonList rows={2} /> : null;
}

/** Shares the project with its workspace, or makes it private again (section 3). */
function AudienceDialog({ open, project, workspace, impact, impactFailed, onClose }: DialogProps) {
  const { t } = useTranslation();
  const mutation = useSetProjectAudienceMutation(t("projects.held"));
  const toShared = project.audience === "private";
  const kept = impact?.conversationsKeptPrivate ?? 0;
  const keptFiles = impact?.filesKeptPrivate ?? 0;
  const close = () => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };
  return (
    <ConfirmDialog
      open={open}
      title={
        toShared
          ? t("projectSettings.shareTitle", { title: project.title, workspace: workspace.name })
          : t("projectSettings.privateTitle", { title: project.title })
      }
      confirmLabel={
        toShared ? t("projectSettings.shareConfirm") : t("projectSettings.privateConfirm")
      }
      tone="primary"
      loading={mutation.isPending}
      confirmDisabled={impact === undefined || (toShared && kept + keptFiles > 0)}
      onConfirm={() =>
        mutation.mutate(
          { project, audience: toShared ? "workspace" : "private" },
          {
            onSuccess: () => {
              mutation.reset();
              onClose();
            }
          }
        )
      }
      onClose={close}
    >
      <div className="grid gap-3" data-testid="project-audience-dialog">
        <ImpactState impact={impact} failed={impactFailed} />
        {impact ? (
          toShared ? (
            <>
              <p>
                {t("projectSettings.shareBody", {
                  workspace: workspace.name,
                  chats: count(t, "chats", impact.conversations)
                })}
              </p>
              {kept > 0 ? (
                <Banner layout="inline" tone="warning" data-testid="project-audience-kept">
                  {t("projectSettings.shareKept", { chats: count(t, "chats", kept) })}
                </Banner>
              ) : null}
              {keptFiles > 0 ? (
                <Banner layout="inline" tone="warning" data-testid="project-audience-kept-files">
                  {t("projectSettings.shareKeptFiles", { files: count(t, "files", keptFiles) })}
                </Banner>
              ) : null}
            </>
          ) : (
            <>
              <p>{t("projectSettings.privateBody", { workspace: workspace.name })}</p>
              {impact.conversationsOfOthers > 0 ? (
                <Banner layout="inline" tone="warning" data-testid="project-audience-others">
                  {t("projectSettings.privateOthers", {
                    chats: count(t, "chats", impact.conversationsOfOthers),
                    workspace: workspace.name
                  })}
                  {impact.filesOfOthers > 0
                    ? ` ${t("projectSettings.privateFiles", {
                        files: count(t, "files", impact.filesOfOthers)
                      })}`
                    : null}
                </Banner>
              ) : null}
            </>
          )
        ) : null}
        {mutation.isError ? (
          <FormNotice tone="error">{failure(t, mutation.error)}</FormNotice>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

/** Moves the project with its chats and files to another workspace of the person (section 10). */
function MoveDialog({
  open,
  project,
  workspace,
  workspaces,
  impact,
  impactFailed,
  onClose,
  onMoved
}: DialogProps & {
  workspaces: readonly ProjectSettingsWorkspace[];
  onMoved(project: ProjectView): void;
}) {
  const { t } = useTranslation();
  const mutation = useMoveProjectMutation(t("projects.held"));
  const [destinationId, setDestinationId] = useState<string>();
  const [audience, setAudience] = useState<ProjectAudienceView>("private");
  const destinations = workspaces.filter((choice) => choice.id !== workspace.id);
  const destination = destinations.find((choice) => choice.id === destinationId);
  // Out of a Personal Workspace the person says who sees it; otherwise it keeps its audience.
  const chooses = workspace.kind === "personal" && destination?.kind === "shared";

  useEffect(() => {
    if (!open) {
      setDestinationId(undefined);
      setAudience("private");
    }
  }, [open]);

  const close = () => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };
  const audienceLabel = (value: ProjectAudienceView, name: string) =>
    value === "private"
      ? t("projects.audiencePrivate")
      : t("projects.audienceShared", { workspace: name });

  return (
    <Dialog
      open={open}
      title={t("projectSettings.moveTitle", { title: project.title })}
      description={t("projectSettings.moveDescription")}
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={mutation.isPending}>
            {t("projects.cancel")}
          </Button>
          <Button
            loading={mutation.isPending}
            disabled={!destination}
            onClick={() => {
              if (!destination) return;
              mutation.mutate(
                {
                  project,
                  collaborationWorkspaceId: destination.id,
                  ...(chooses ? { audience } : {})
                },
                {
                  onSuccess: (moved) => {
                    mutation.reset();
                    onMoved(moved.project);
                  }
                }
              );
            }}
          >
            {t("projectSettings.moveConfirm")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4" data-testid="project-move-dialog">
        {destinations.length === 0 ? (
          <EmptyState layout="inline">{t("projectSettings.moveNone")}</EmptyState>
        ) : (
          <RadioGroup
            label={t("projectSettings.moveTo")}
            labelHidden
            variant="plain"
            value={destinationId ?? ""}
            onValueChange={setDestinationId}
            options={destinations.map((choice) => ({ value: choice.id, label: choice.name }))}
          />
        )}
        {impact ? (
          <p className="text-muted-foreground text-sm">
            {count(t, "chats", impact.conversations)} · {count(t, "files", impact.files)}
          </p>
        ) : (
          <ImpactState impact={impact} failed={impactFailed} />
        )}
        {destination ? (
          chooses ? (
            <RadioGroup<ProjectAudienceView>
              label={t("projectSettings.moveAudience")}
              value={audience}
              onValueChange={setAudience}
              options={[
                {
                  value: "private",
                  label: t("projects.audiencePrivate"),
                  description: t("projects.audiencePrivateHint")
                },
                {
                  value: "workspace",
                  label: t("projects.audienceShared", { workspace: destination.name }),
                  description: t("projects.audienceSharedHint")
                }
              ]}
            />
          ) : (
            <Banner layout="inline" tone="info" data-testid="project-move-audience">
              {destination.kind === "personal"
                ? t("projectSettings.movePersonal")
                : t("projectSettings.moveKeeps", {
                    audience: audienceLabel(project.audience, destination.name)
                  })}
            </Banner>
          )
        ) : null}
        {mutation.isError ? (
          <FormNotice tone="error">{failure(t, mutation.error)}</FormNotice>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Deletes the project; its chats stay in the workspace or are deleted too (section 10). */
function DeleteDialog({
  open,
  project,
  workspace,
  impact,
  impactFailed,
  onClose,
  onDeleted
}: DialogProps & { onDeleted(): void }) {
  const { t } = useTranslation();
  const mutation = useDeleteProjectMutation(t("projects.held"));
  const [conversations, setConversations] = useState<ProjectDeletionConversationsView>("keep");

  useEffect(() => {
    if (!open) setConversations("keep");
  }, [open]);

  const close = () => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };
  return (
    <ConfirmDialog
      open={open}
      title={t("projectSettings.deleteTitle", { title: project.title })}
      confirmLabel={t("projectSettings.deleteConfirm")}
      tone="danger"
      loading={mutation.isPending}
      confirmDisabled={impact === undefined}
      onConfirm={() =>
        mutation.mutate(
          { project, conversations: (impact?.conversations ?? 0) > 0 ? conversations : "keep" },
          { onSuccess: onDeleted }
        )
      }
      onClose={close}
    >
      <div className="grid gap-4" data-testid="project-delete-dialog">
        <ImpactState impact={impact} failed={impactFailed} />
        {impact ? (
          <>
            <p>{t("projectSettings.deleteBody", { files: count(t, "files", impact.files) })}</p>
            {impact.conversations > 0 ? (
              <RadioGroup<ProjectDeletionConversationsView>
                label={t("projectSettings.deleteChats", {
                  chats: count(t, "chats", impact.conversations)
                })}
                value={conversations}
                onValueChange={setConversations}
                options={[
                  {
                    value: "keep",
                    label: t("projectSettings.deleteKeep", { workspace: workspace.name }),
                    description: t("projectSettings.deleteKeepHint")
                  },
                  {
                    value: "delete",
                    label: t("projectSettings.deleteAlso"),
                    description: t("projectSettings.deleteAlsoHint")
                  }
                ]}
              />
            ) : null}
          </>
        ) : null}
        {mutation.isError ? (
          <FormNotice tone="error">{failure(t, mutation.error)}</FormNotice>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
