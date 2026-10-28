import { Download, FolderInput, Pencil, Upload } from "lucide-react";
import { useState } from "react";
import type { ProjectFileView, ProjectView } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  FileDropZone,
  FilePicker,
  FormNotice,
  IconButton,
  InlineError,
  List,
  ListRow,
  Section,
  SkeletonList,
  type BadgeTone
} from "@work-shape/catalyst-ui";
import { useProjectFilesQuery, useProjectFileWrites } from "../../shared/api/project-files";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { apiErrorCode } from "../../shared/workspace-utils";
import { downloadProjectFile, ProjectFileMoveDialog, ProjectFilePanel } from "./project-file-panel";
import { ProjectFileTree } from "./project-file-tree";
import {
  checkProjectUploads,
  droppedUploads,
  expandProjectUploads,
  formatProjectBytes,
  pickedUploads,
  projectUploadCaps,
  runLimited,
  takenUploadPaths,
  type ProjectUpload,
  type ProjectUploadRefusal
} from "./project-files-model";
import { projectUploadRefusalText } from "./project-zip-upload";

/** Uploads into a project run this many at a time. */
const PROJECT_UPLOADS_AT_ONCE = 2;

type UploadState = "waiting" | "running" | "done" | "unchanged" | "failed" | "changed";

interface UploadRow {
  id: string;
  path: string;
  state: UploadState;
  message?: string;
}

const UPLOAD_STATES: Record<UploadState, { key: TranslationKey; tone: BadgeTone }> = {
  waiting: { key: "projectFiles.uploadWaiting", tone: "neutral" },
  running: { key: "projectFiles.uploadRunning", tone: "info" },
  done: { key: "projectFiles.uploadDone", tone: "success" },
  unchanged: { key: "projectFiles.uploadUnchanged", tone: "neutral" },
  failed: { key: "projectFiles.uploadFailed", tone: "danger" },
  changed: { key: "projectFiles.changedMeanwhile", tone: "warning" }
};

let uploadSequence = 0;

/**
 * The files of a project on its page: the tree, uploads of files, folders and .zip archives, and
 * the panel a file opens in. An upload over a taken path asks first and then replaces the
 * version it saw.
 */
export function ProjectFilesSection({
  project,
  onOpenConversation
}: {
  project: ProjectView;
  onOpenConversation?(conversationId: string): void;
}) {
  const { t, locale } = useTranslation();
  const { client } = useWorkspaceApiClient();
  const files = useProjectFilesQuery(project.id);
  const writes = useProjectFileWrites(project.id, t("projectFiles.held"));
  const [openPath, setOpenPath] = useState<string>();
  const [movingFolder, setMovingFolder] = useState<string>();
  const [reading, setReading] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [replace, setReplace] = useState<{
    uploads: ProjectUpload[];
    taken: Map<string, number>;
  }>();

  const refusalText = (refused: ProjectUploadRefusal): string =>
    projectUploadRefusalText(refused, t, locale);

  const setRow = (id: string, row: Partial<UploadRow>) =>
    setUploads((rows) =>
      rows.map((current) => (current.id === id ? { ...current, ...row } : current))
    );

  async function start(chosen: ProjectUpload[], taken: ReadonlyMap<string, number>) {
    const queued = chosen.map((upload) => {
      uploadSequence += 1;
      return { upload, id: `upload-${uploadSequence}` };
    });
    setUploads((rows) => [
      ...rows,
      ...queued.map(({ upload, id }) => ({ id, path: upload.path, state: "waiting" as const }))
    ]);
    await runLimited(queued, PROJECT_UPLOADS_AT_ONCE, async ({ upload, id }) => {
      setRow(id, { state: "running" });
      try {
        const change = await writes.upload({
          file: await upload.read(),
          path: upload.path,
          replaces: taken.get(upload.path)
        });
        setRow(id, { state: change.change === "unchanged" ? "unchanged" : "done" });
      } catch (error) {
        const held = error instanceof Error && error.message === t("projectFiles.held");
        setRow(
          id,
          apiErrorCode(error) === "CONFLICT"
            ? { state: "changed" }
            : { state: "failed", message: held ? t("projectFiles.held") : undefined }
        );
      }
    });
  }

  async function take(read: Promise<ProjectUpload[]>) {
    setRefusal(undefined);
    setReading(true);
    try {
      const current = files.data;
      if (!current) return;
      const expanded = await expandProjectUploads(await read, projectUploadCaps(current));
      if (!expanded.ok) {
        setRefusal(refusalText(expanded.refusal));
        return;
      }
      if (expanded.uploads.length === 0) return;
      const refused = checkProjectUploads(expanded.uploads, {
        usage: current.usage,
        limits: current.limits,
        paths: new Set(current.items.map((file) => file.path))
      });
      if (refused) {
        setRefusal(refusalText(refused));
        return;
      }
      const taken = takenUploadPaths(expanded.uploads, current.items);
      if (taken.size > 0) {
        setReplace({ uploads: expanded.uploads, taken });
        return;
      }
      await start(expanded.uploads, taken);
    } catch {
      setRefusal(t("projectFiles.actionFailed"));
    } finally {
      setReading(false);
    }
  }

  const takenNames = replace ? [...replace.taken.keys()] : [];
  const usage = files.data
    ? t(files.data.usage.files === 1 ? "projectFiles.usageOne" : "projectFiles.usage", {
        files: files.data.usage.files,
        bytes: formatProjectBytes(files.data.usage.bytes, locale),
        max: formatProjectBytes(files.data.limits.maxProjectBytes, locale)
      })
    : undefined;
  const busy = reading || !files.data;

  return (
    <Section
      layout="stacked"
      title={t("projectFiles.title")}
      count={files.data?.items.length}
      description={usage}
      data-testid="project-files"
      action={
        <div className="flex flex-wrap gap-2">
          <FilePicker
            multiple
            onFiles={(picked) => {
              take(Promise.resolve(pickedUploads(picked))).catch(() => undefined);
            }}
          >
            {(choose) => (
              <Button variant="outline" size="sm" disabled={busy} onClick={choose}>
                <Upload aria-hidden="true" />
                {t("projectFiles.upload")}
              </Button>
            )}
          </FilePicker>
          <FilePicker
            directory
            onFiles={(picked) => {
              take(Promise.resolve(pickedUploads(picked))).catch(() => undefined);
            }}
          >
            {(choose) => (
              <Button variant="outline" size="sm" disabled={busy} onClick={choose}>
                <FolderInput aria-hidden="true" />
                {t("projectFiles.uploadFolder")}
              </Button>
            )}
          </FilePicker>
        </div>
      }
    >
      <div className="grid gap-3">
        {refusal ? <FormNotice tone="error">{refusal}</FormNotice> : null}
        {files.isPending ? (
          <SkeletonList rows={3} />
        ) : files.isError ? (
          <InlineError className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("projectFiles.listFailed")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                files.refetch().catch(() => undefined);
              }}
            >
              {t("tryAgain")}
            </Button>
          </InlineError>
        ) : files.data.items.length === 0 ? (
          <EmptyState>{t("projectFiles.empty")}</EmptyState>
        ) : (
          <ProjectFileTree
            files={files.data.items}
            selectedPath={openPath}
            onOpen={(file) => setOpenPath(file.path)}
            fileActions={(file: ProjectFileView) => (
              <IconButton
                size="sm"
                label={t("projectFiles.download")}
                onClick={() => {
                  downloadProjectFile(client, project.id, file.path).catch(() =>
                    setRefusal(t("projectFiles.actionFailed"))
                  );
                }}
              >
                <Download aria-hidden="true" />
              </IconButton>
            )}
            folderActions={(path) => (
              <IconButton
                size="sm"
                label={t("projectFiles.renameFolder")}
                onClick={() => setMovingFolder(path)}
              >
                <Pencil aria-hidden="true" />
              </IconButton>
            )}
          />
        )}
        <FileDropZone
          disabled={busy}
          className="py-4"
          onDrop={(data) => {
            take(droppedUploads(data)).catch(() => undefined);
          }}
        >
          <span>{reading ? t("projectFiles.reading") : t("projectFiles.dropHint")}</span>
        </FileDropZone>
        {uploads.length > 0 ? (
          <div className="grid gap-1">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-label font-medium">{t("projectFiles.uploads")}</h3>
              {uploads.every((row) => row.state !== "waiting" && row.state !== "running") ? (
                <Button variant="ghost" size="sm" onClick={() => setUploads([])}>
                  {t("projectFiles.clearUploads")}
                </Button>
              ) : null}
            </div>
            <List aria-label={t("projectFiles.uploads")}>
              {uploads.map((row) => (
                <ListRow
                  key={row.id}
                  size="compact"
                  data-testid="project-file-upload"
                  data-state={row.state}
                  title={row.path}
                  description={row.message}
                  time={
                    <Badge size="sm" tone={UPLOAD_STATES[row.state].tone}>
                      {t(UPLOAD_STATES[row.state].key)}
                    </Badge>
                  }
                />
              ))}
            </List>
          </div>
        ) : null}
      </div>
      <ProjectFilePanel
        projectId={project.id}
        path={openPath}
        files={files.data}
        onClose={() => setOpenPath(undefined)}
        onOpenPath={setOpenPath}
        onOpenConversation={onOpenConversation}
      />
      <ProjectFileMoveDialog
        projectId={project.id}
        from={movingFolder}
        onClose={() => setMovingFolder(undefined)}
      />
      <ConfirmDialog
        open={replace !== undefined}
        tone="primary"
        title={t("projectFiles.replaceTitle")}
        confirmLabel={t("projectFiles.replaceConfirm")}
        onConfirm={() => {
          const chosen = replace;
          setReplace(undefined);
          if (chosen) start(chosen.uploads, chosen.taken).catch(() => undefined);
        }}
        onClose={() => {
          const chosen = replace;
          setReplace(undefined);
          if (!chosen) return;
          const rest = chosen.uploads.filter((upload) => !chosen.taken.has(upload.path));
          if (rest.length > 0) start(rest, new Map()).catch(() => undefined);
        }}
      >
        <p>
          {takenNames.length === 1
            ? t("projectFiles.replaceOne", { name: takenNames[0] ?? "" })
            : t("projectFiles.replaceMany", {
                count: takenNames.length,
                names: takenNames.slice(0, 5).join(", ") + (takenNames.length > 5 ? ", …" : "")
              })}
        </p>
        {replace && replace.uploads.length > replace.taken.size ? (
          <p className="mt-2 text-muted-foreground">{t("projectFiles.replaceRest")}</p>
        ) : null}
      </ConfirmDialog>
    </Section>
  );
}
