import { FolderOpen } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  FormNotice,
  IconButton,
  InlineError,
  Select,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useAddFromProjectMutation, useProjectFilesQuery } from "../../shared/api/project-files";
import { useProjectsQuery } from "../../shared/api/projects";
import { useTranslation } from "../../shared/i18n";
import { apiErrorCode, apiErrorReason } from "../../shared/workspace-utils";
import { ProjectFileTree } from "./project-file-tree";

/** The open conversation a project file is attached to, while the projects module is on. */
interface AddFromProjectTarget {
  conversationId: string;
  collaborationWorkspaceId: string;
  /** The conversation's own project, chosen first. */
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

/** The composer's "Add from project", beside the paperclip; nothing without a target. */
export function AddFromProjectButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const target = useContext(AddFromProjectContext);
  const [open, setOpen] = useState(false);
  if (!target) return null;
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
      {open ? <AddFromProjectDialog target={target} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddFromProjectDialog({
  target,
  onClose
}: {
  target: AddFromProjectTarget;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const projects = useProjectsQuery(target.collaborationWorkspaceId);
  const [projectId, setProjectId] = useState(target.projectId ?? "");
  const [path, setPath] = useState<string>();
  const files = useProjectFilesQuery(projectId || undefined);
  const add = useAddFromProjectMutation(target.conversationId, t("projectFiles.held"));
  useEffect(() => {
    if (projectId === "" && projects.data?.[0]) setProjectId(projects.data[0].id);
  }, [projectId, projects.data]);

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
            disabled={!path || projectId === ""}
            onClick={() => {
              if (!path) return;
              add.mutate(
                { projectId, path, ...(target.agentName ? { agentName: target.agentName } : {}) },
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
        <Field label={t("projectFiles.fieldProject")}>
          <Select
            value={projectId}
            disabled={!projects.data}
            onChange={(event) => {
              // Another project starts a fresh pick.
              setProjectId(event.currentTarget.value);
              setPath(undefined);
              add.reset();
            }}
          >
            {projectId === "" ? <option value="" /> : null}
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-2">
          <span className="text-label font-medium">{t("projectFiles.fieldFile")}</span>
          {projectId === "" ? (
            projects.isPending ? (
              <SkeletonList rows={3} />
            ) : (
              <EmptyState>{t("projectFiles.noFiles")}</EmptyState>
            )
          ) : files.isPending ? (
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
