import { useEffect, useState } from "react";
import type { ConversationListItem } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  FormNotice,
  RadioGroup,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useProjectsQuery, useSetConversationProjectMutation } from "../../shared/api/projects";
import { conversationTitle } from "../../shared/conversation-title";
import { useTranslation } from "../../shared/i18n";

/** What a conversation's menu asked about its project (PRJ-1). */
export type ProjectChange =
  | { kind: "move"; conversation: ConversationListItem }
  | { kind: "remove"; conversation: ConversationListItem };

/**
 * Moves a conversation into a project of its workspace, or takes it out of its project. A
 * conversation takes the audience of the project it enters, which the dialog says before the
 * move; a private one cannot enter a shared project's audience without being shown to all.
 */
export function ProjectChangeDialogs({
  change,
  workspaceName,
  onClose
}: {
  change: ProjectChange | undefined;
  /** The name of the conversation's workspace, as the interface shows it. */
  workspaceName: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const mutation = useSetConversationProjectMutation(t("projects.held"));
  const close = () => {
    if (mutation.isPending) return;
    mutation.reset();
    onClose();
  };
  const title = change ? conversationTitle(change.conversation.title, t) : "";

  return (
    <>
      <MoveDialog
        open={change?.kind === "move"}
        conversation={change?.kind === "move" ? change.conversation : undefined}
        title={title}
        workspaceName={workspaceName}
        pending={mutation.isPending}
        failed={mutation.isError}
        onClose={close}
        onMove={(conversationId, projectId, hideFromOthers) =>
          mutation.mutate(
            { conversationId, projectId, ...(hideFromOthers ? { hideFromOthers } : {}) },
            { onSuccess: onClose }
          )
        }
      />
      <ConfirmDialog
        open={change?.kind === "remove"}
        title={t("projects.removeTitle", { title })}
        confirmLabel={t("projects.removeMenuItem")}
        tone="primary"
        loading={mutation.isPending}
        onConfirm={() => {
          if (change?.kind === "remove") {
            mutation.mutate(
              { conversationId: change.conversation.id, projectId: null },
              { onSuccess: onClose }
            );
          }
        }}
        onClose={close}
      >
        <div className="grid gap-3">
          <p>{t("projects.removeBody", { workspace: workspaceName })}</p>
          {mutation.isError ? (
            <FormNotice tone="error">{t("projects.moveFailed")}</FormNotice>
          ) : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

function MoveDialog({
  open,
  conversation,
  title,
  workspaceName,
  pending,
  failed,
  onClose,
  onMove
}: {
  open: boolean;
  conversation: ConversationListItem | undefined;
  title: string;
  workspaceName: string;
  pending: boolean;
  failed: boolean;
  onClose(): void;
  /** `hideFromOthers`: the person saw that the others no longer read the conversation. */
  onMove(conversationId: string, projectId: string, hideFromOthers: boolean): void;
}) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState<string>();
  const projects = useProjectsQuery(conversation?.collaborationWorkspaceId ?? "");
  const destinations = (projects.data ?? []).filter(
    (project) => project.id !== conversation?.projectId
  );
  const destination = destinations.find((project) => project.id === projectId);

  useEffect(() => {
    if (!open) setProjectId(undefined);
  }, [open]);

  return (
    <Dialog
      open={open}
      title={t("projects.moveTitle")}
      description={t("projects.moveDescription", { workspace: workspaceName, title })}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t("projects.cancel")}
          </Button>
          <Button
            loading={pending}
            disabled={!destination || !conversation}
            onClick={() => {
              if (destination && conversation) {
                onMove(
                  conversation.id,
                  destination.id,
                  destination.audience === "private" && conversation.visibility === "workspace"
                );
              }
            }}
          >
            {t("projects.move")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {projects.isPending ? (
          <SkeletonList rows={2} />
        ) : destinations.length === 0 ? (
          <EmptyState layout="inline">{t("projects.moveNone")}</EmptyState>
        ) : (
          <RadioGroup
            label={t("projects.title")}
            labelHidden
            variant="plain"
            value={projectId ?? ""}
            onValueChange={setProjectId}
            options={destinations.map((project) => ({
              value: project.id,
              label: project.title,
              description:
                project.audience === "private"
                  ? t("projects.audiencePrivate")
                  : t("projects.audienceShared", { workspace: workspaceName })
            }))}
          />
        )}
        {destination && conversation && destination.audience !== conversation.visibility ? (
          <Banner
            layout="inline"
            // Either way others' reading changes: shown to all, or hidden from those who read it.
            tone="warning"
            data-testid="project-move-audience"
          >
            {destination.audience === "workspace"
              ? t("projects.moveShared", { workspace: workspaceName })
              : t("projects.movePrivate", { workspace: workspaceName })}
          </Banner>
        ) : null}
        {failed ? <FormNotice tone="error">{t("projects.moveFailed")}</FormNotice> : null}
      </div>
    </Dialog>
  );
}
