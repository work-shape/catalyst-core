import { FileText } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { PROJECT_FOLDER_WRITE_CHANGES } from "@work-shape/catalyst-core";
import { Button } from "@work-shape/catalyst-ui";
import {
  useInvalidateProjectFiles,
  useProjectFilesQuery,
  useProjectFileWrites
} from "../../shared/api/project-files";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { apiErrorCode } from "../../shared/workspace-utils";
import { toolAnswer } from "../conversation/subject-run";
import { ProjectFilePanel } from "./project-file-panel";
import { projectFileName } from "./project-files-model";

/** The tools whose answer names the project file they wrote. */
const PROJECT_WRITE_TOOL_NAMES = new Set(["workspace.write_file", "workspace.edit_file"]);

/** What a write of the agent did to a file of the chat's project, as its answer says it. */
export interface ProjectFileChange {
  projectId: string;
  path: string;
  version: number;
  change: (typeof PROJECT_FOLDER_WRITE_CHANGES)[number];
  previousVersion?: number;
  /** For a conflict copy: the file that changed meanwhile, as it is now. */
  changed?: { path: string; version: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChange(value: unknown): value is ProjectFileChange["change"] {
  return PROJECT_FOLDER_WRITE_CHANGES.some((change) => change === value);
}

/** The project change a write of the agent answered with; nothing for any other call. */
export function readProjectFileChange(call: {
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}): ProjectFileChange | undefined {
  if (call.isError === true || !call.toolName || !PROJECT_WRITE_TOOL_NAMES.has(call.toolName)) {
    return undefined;
  }
  const project = toolAnswer(call.result)?.project;
  if (!isRecord(project)) return undefined;
  const { projectId, path, version, change, previousVersion, changed } = project;
  if (
    typeof projectId !== "string" ||
    typeof path !== "string" ||
    typeof version !== "number" ||
    !isChange(change)
  ) {
    return undefined;
  }
  return {
    projectId,
    path,
    version,
    change,
    ...(typeof previousVersion === "number" ? { previousVersion } : {}),
    ...(isRecord(changed) && typeof changed.path === "string" && typeof changed.version === "number"
      ? { changed: { path: changed.path, version: changed.version } }
      : {})
  };
}

/** A write of the agent to a project file: its line stays in the thread after the run. */
export function isProjectFileChangeCall(part: {
  type: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}): boolean {
  return part.type === "tool-call" && readProjectFileChange(part) !== undefined;
}

const CHANGE_KEYS: Record<ProjectFileChange["change"], TranslationKey> = {
  created: "projectFiles.changeCreated",
  updated: "projectFiles.changeUpdated",
  conflict_copy: "projectFiles.changeConflictCopy",
  unchanged: "projectFiles.changeUnchanged"
};

// Stands for the name in a translated sentence, where the name is a button.
const NAME_MARK = "\u0001";

function withName(text: string, name: ReactNode): ReactNode {
  const at = text.indexOf(NAME_MARK);
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      {name}
      {text.slice(at + NAME_MARK.length)}
    </>
  );
}

type UndoState = "idle" | "pending" | "undone" | "changed" | "failed";

/** The project's files read for the panel only while it is open. */
function ChangedFilePanel({
  projectId,
  path,
  onClose
}: {
  projectId: string;
  path: string;
  onClose(): void;
}) {
  const files = useProjectFilesQuery(projectId);
  const [openPath, setOpenPath] = useState(path);
  return (
    <ProjectFilePanel
      projectId={projectId}
      path={openPath}
      files={files.data}
      onClose={onClose}
      onOpenPath={setOpenPath}
    />
  );
}

/**
 * The line a write of the agent to a project file leaves in the thread: "checkliste.md
 * erstellt · v1 · Rückgängig". The name opens the file; Undo deletes a file the write created
 * and restores the version an update replaced, unless the file changed since.
 */
export function ProjectFileChangeLine({ change }: { change: ProjectFileChange }) {
  const { t } = useTranslation();
  const writes = useProjectFileWrites(change.projectId, t("projectFiles.held"));
  const [undo, setUndo] = useState<UndoState>("idle");
  const [open, setOpen] = useState(false);
  const name = projectFileName(change.path);
  const invalidate = useInvalidateProjectFiles();
  // The agent changed the folder: the tree in "Inhalte" and on the page reads it again, once
  // per change the line shows.
  useEffect(() => {
    invalidate(change.projectId);
  }, [change.projectId, change.path, change.version]);
  const undoable =
    change.change === "created" ||
    change.change === "conflict_copy" ||
    (change.change === "updated" && change.previousVersion !== undefined);

  function runUndo() {
    setUndo("pending");
    const done =
      change.change === "updated" && change.previousVersion !== undefined
        ? writes.restore({
            path: change.path,
            version: change.previousVersion,
            replaces: change.version
          })
        : writes.remove({ path: change.path, replaces: change.version });
    done
      .then(() => setUndo("undone"))
      .catch((error: unknown) =>
        setUndo(apiErrorCode(error) === "CONFLICT" ? "changed" : "failed")
      );
  }

  const nameButton = (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs font-medium text-foreground"
      title={change.path}
      onClick={() => setOpen(true)}
    >
      {name}
    </Button>
  );

  return (
    <>
      <p
        className="chat-tool-part my-1 flex max-w-3xl flex-wrap items-center gap-x-1 text-xs text-muted-foreground"
        data-testid="project-file-change-line"
        data-change={change.change}
      >
        <span className="mr-1 flex h-4 shrink-0 items-center">
          <FileText aria-hidden="true" className="size-3.5" />
        </span>
        <span className="min-w-0">
          {withName(t(CHANGE_KEYS[change.change], { name: NAME_MARK }), nameButton)}
          {` · ${t("projectFiles.version", { version: change.version })}`}
          {change.change === "conflict_copy" && change.changed
            ? ` – ${t("projectFiles.changeConflictChanged", {
                name: projectFileName(change.changed.path),
                version: change.changed.version
              })}`
            : null}
          {undoable ? (
            <>
              {" · "}
              {undo === "undone" ? (
                <span data-testid="project-file-undo-state">{t("projectFiles.undone")}</span>
              ) : undo === "changed" ? (
                <span data-testid="project-file-undo-state">
                  {t("projectFiles.changedMeanwhile")}
                </span>
              ) : (
                <>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    data-testid="project-file-undo"
                    disabled={undo === "pending"}
                    onClick={runUndo}
                  >
                    {t("projectFiles.undo")}
                  </Button>
                  {undo === "failed" ? (
                    <span role="alert">{` – ${t("projectFiles.undoFailed")}`}</span>
                  ) : null}
                </>
              )}
            </>
          ) : null}
        </span>
      </p>
      {open ? (
        <ChangedFilePanel
          projectId={change.projectId}
          path={change.path}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
