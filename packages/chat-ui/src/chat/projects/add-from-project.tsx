import { FolderOpen } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  EmptyState,
  FormNotice,
  IconButton,
  InlineError,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useAddFromProjectMutation, useProjectFilesQuery } from "../../shared/api/project-files";
import { useTranslation } from "../../shared/i18n";
import { apiErrorCode, apiErrorReason } from "../../shared/workspace-utils";
import { ProjectFileTree } from "./project-file-tree";

/** The open conversation a project file is attached to, while the projects module is on. */
interface AddFromProjectTarget {
  conversationId: string;
  /** The project the conversation belongs to; absent in a conversation outside any project. */
  projectId?: string;
  agentName?: string;
}

const AddFromProjectContext = createContext<AddFromProjectTarget | undefined>(undefined);

/** Lets the composer attach project files to the conversation it writes in. */
export function AddFromProjectProvider({
  target,
  children
}: {
  /** Absent where there is no conversation yet or the module is off: the action does not show. */
  target: AddFromProjectTarget | undefined;
  children: ReactNode;
}) {
  return <AddFromProjectContext.Provider value={target}>{children}</AddFromProjectContext.Provider>;
}

/**
 * The open conversation and its project, where the module is on: what the line about the
 * project's instructions and the card on an agent's change of them read (PRJ-3).
 */
export function useOpenConversationProject(): AddFromProjectTarget | undefined {
  return useContext(AddFromProjectContext);
}

/**
 * The composer's "Add from project", beside the paperclip. It shows only in a conversation that
 * belongs to a project, and picks from that project's files only.
 */
export function AddFromProjectButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const target = useContext(AddFromProjectContext);
  const [open, setOpen] = useState(false);
  if (!target?.projectId) return null;
  return (
    <>
      <IconButton
        size="lg"
        className={className}
        label={t("projectFiles.addFromProject")}
        data-testid="add-from-project"
        onClick={() => setOpen(true)}
      >
        <FolderOpen size={16} aria-hidden="true" />
      </IconButton>
      {open ? (
        <AddFromProjectDialog
          conversationId={target.conversationId}
          projectId={target.projectId}
          agentName={target.agentName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AddFromProjectDialog({
  conversationId,
  projectId,
  agentName,
  onClose
}: {
  conversationId: string;
  projectId: string;
  agentName?: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string>();
  const files = useProjectFilesQuery(projectId);
  const add = useAddFromProjectMutation(conversationId, t("projectFiles.held"));

  const error = add.error
    ? apiErrorCode(add.error) === "VALIDATION_FAILED" &&
      apiErrorReason(add.error) === "project_audience_wider"
      ? t("projectFiles.audienceWider")
      : add.error instanceof Error && add.error.message === t("projectFiles.held")
        ? t("projectFiles.held")
        : t("projectFiles.addFailed")
    : undefined;

  return (
    <Dialog
      open
      size="md"
      title={t("projectFiles.addFromProject")}
      description={t("projectFiles.addFromProjectDescription")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            data-testid="add-from-project-confirm"
            loading={add.isPending}
            disabled={!path}
            onClick={() => {
              if (!path) return;
              add.mutate(
                { projectId, path, ...(agentName ? { agentName } : {}) },
                { onSuccess: onClose }
              );
            }}
          >
            {t("projectFiles.add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4" data-testid="add-from-project-dialog">
        <div className="grid gap-2">
          <span className="text-label font-medium">{t("projectFiles.fieldFile")}</span>
          {files.isPending ? (
            <SkeletonList rows={3} />
          ) : files.isError ? (
            <InlineError>{t("projectFiles.listFailed")}</InlineError>
          ) : files.data.items.length === 0 ? (
            <EmptyState>{t("projectFiles.noFiles")}</EmptyState>
          ) : (
            <div className="max-h-[40dvh] overflow-y-auto">
              <ProjectFileTree
                files={files.data.items}
                selectedPath={path}
                onOpen={(file) => setPath(file.path)}
              />
            </div>
          )}
        </div>
        {error ? (
          <FormNotice tone="error" data-testid="add-from-project-error">
            {error}
          </FormNotice>
        ) : null}
      </div>
    </Dialog>
  );
}
