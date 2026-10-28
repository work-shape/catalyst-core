import { useEffect, useId, useState, type FormEvent } from "react";
import type {
  ApiClient,
  ProjectFilesView,
  ProjectFileVersionView,
  ProjectFileView
} from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  FormNotice,
  InlineError,
  Input,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  SkeletonList,
  Spinner
} from "@work-shape/catalyst-ui";
import {
  loadProjectFileBlob,
  useProjectFileVersionsQuery,
  useProjectFileWrites
} from "../../shared/api/project-files";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { formatDateTime } from "../../shared/locale-format";
import { StoredFileView } from "../../shared/stored-file-view";
import { apiErrorCode } from "../../shared/workspace-utils";
import { saveBlobAsFile } from "../files/conversation-file-content";
import { viewerObjectUrl } from "../files/viewer-object-url";
import {
  formatProjectBytes,
  PROJECT_FILE_TEXT_PREVIEW_MAX_BYTES,
  projectFileName,
  projectFilePreviewKind
} from "./project-files-model";

const ORIGIN_KEYS: Record<ProjectFileView["origin"], TranslationKey> = {
  person: "projectFiles.originPerson",
  agent: "projectFiles.originAgent",
  upload: "projectFiles.originUpload"
};

/** Downloads a project file, the current version or an older one, under its own name. */
export async function downloadProjectFile(
  client: ApiClient | undefined,
  projectId: string,
  path: string,
  version?: number
): Promise<void> {
  if (!client) return;
  const blob = await loadProjectFileBlob(client, projectId, path, { version, download: true });
  saveBlobAsFile(blob, projectFileName(path));
}

type PreviewState =
  | { status: "loading" }
  | { status: "text"; text: string }
  | { status: "url"; url: string }
  | { status: "failed" };

/** The content of a file as its kind shows: text, an image, a PDF, or nothing to show. */
function ProjectFilePreview({ projectId, file }: { projectId: string; file: ProjectFileView }) {
  const { t } = useTranslation();
  const client = useOptionalWorkspaceApiClient()?.client;
  const kind = projectFilePreviewKind(file);
  const tooLarge = kind === "text" && file.byteSize > PROJECT_FILE_TEXT_PREVIEW_MAX_BYTES;
  const shown = kind !== "none" && !tooLarge;
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    if (!shown || !client) return undefined;
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ status: "loading" });
    loadProjectFileBlob(client, projectId, file.path, { version: file.version })
      .then(async (blob) => {
        if (kind === "text") {
          const text = await blob.text();
          if (!cancelled) setState({ status: "text", text });
          return;
        }
        if (cancelled) return;
        objectUrl = viewerObjectUrl(blob, kind === "pdf" ? "pdf" : "image");
        setState({ status: "url", url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, projectId, file.path, file.version, kind, shown]);

  if (!shown) {
    return (
      <EmptyState>
        {t(tooLarge ? "projectFiles.previewTooLarge" : "projectFiles.previewNone")}
      </EmptyState>
    );
  }
  if (state.status === "loading") return <SkeletonList rows={3} />;
  if (state.status === "failed")
    return <InlineError>{t("projectFiles.previewFailed")}</InlineError>;
  if (state.status === "text") {
    return <StoredFileView path={file.path} text={state.text} className="max-h-[50dvh]" />;
  }
  return kind === "pdf" ? (
    <iframe
      title={projectFileName(file.path)}
      src={state.url}
      className="h-[60dvh] w-full rounded-md border border-input"
    />
  ) : (
    <img
      src={state.url}
      alt={projectFileName(file.path)}
      className="max-h-[60dvh] w-full rounded-md border border-input object-contain"
    />
  );
}

/** Who made a version, as the version list names it: their name, or a former member. */
function versionAuthor(
  version: Pick<ProjectFileVersionView, "by">,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  return version.by?.label ?? t("projectFiles.formerMember");
}

export function ProjectFileVersions({
  projectId,
  path,
  onOpenConversation,
  onFailed
}: {
  projectId: string;
  path: string;
  onOpenConversation?(conversationId: string): void;
  onFailed(message: string): void;
}) {
  const { t, locale } = useTranslation();
  const versions = useProjectFileVersionsQuery(projectId, path);
  const writes = useProjectFileWrites(projectId, t("projectFiles.held"));
  const [restoring, setRestoring] = useState<number>();
  if (versions.isPending) return <SkeletonList rows={2} />;
  if (versions.isError) return <InlineError>{t("projectFiles.versionsFailed")}</InlineError>;
  const { currentVersion, items } = versions.data;
  const newest = items[0]?.version;
  return (
    <List aria-label={t("projectFiles.versions")} data-testid="project-file-versions">
      {items.map((version) => {
        const current = version.version === currentVersion;
        const restorable = !current && !version.deleted;
        return (
          <ListRow
            key={version.version}
            size="compact"
            data-testid="project-file-version"
            data-version={version.version}
            title={`${t("projectFiles.version", { version: version.version })} · ${versionAuthor(version, t)}`}
            chips={
              current ? (
                <Badge size="sm">{t("projectFiles.versionCurrent")}</Badge>
              ) : version.deleted ? (
                <Badge size="sm" tone="danger">
                  {t("projectFiles.versionDeleted")}
                </Badge>
              ) : undefined
            }
            description={
              <>
                {t(ORIGIN_KEYS[version.origin])} · {formatDateTime(version.at, locale)}
                {version.conversationId ? (
                  <>
                    {" · "}
                    {onOpenConversation ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-caption"
                        onClick={() => onOpenConversation(version.conversationId ?? "")}
                      >
                        {t("projectFiles.fromChat")}
                      </Button>
                    ) : (
                      t("projectFiles.fromChat")
                    )}
                  </>
                ) : null}
              </>
            }
            descriptionWraps="always"
            actionsVisible
            actions={
              restorable ? (
                <Button
                  variant="outline"
                  size="sm"
                  loading={restoring === version.version}
                  disabled={restoring !== undefined}
                  onClick={() => {
                    setRestoring(version.version);
                    writes
                      .restore({
                        path,
                        version: version.version,
                        replaces: currentVersion ?? newest
                      })
                      .catch((error: unknown) =>
                        onFailed(
                          apiErrorCode(error) === "CONFLICT"
                            ? t("projectFiles.changedMeanwhile")
                            : t("projectFiles.actionFailed")
                        )
                      )
                      .finally(() => setRestoring(undefined));
                  }}
                >
                  {t("projectFiles.restore")}
                </Button>
              ) : undefined
            }
          />
        );
      })}
    </List>
  );
}

/**
 * Renames or moves a file, or a folder with every file below it: a folder's paths end in `/`.
 * Answers the new path once the move is done.
 */
export function ProjectFileMoveDialog({
  projectId,
  from,
  onClose,
  onMoved
}: {
  projectId: string;
  /** The path to move, `undefined` while the dialog is closed. */
  from: string | undefined;
  onClose(): void;
  onMoved?(to: string): void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const writes = useProjectFileWrites(projectId, t("projectFiles.held"));
  const folder = from?.endsWith("/") ?? false;
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setValue(from?.replace(/\/$/u, "") ?? "");
    setError(undefined);
  }, [from]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!from) return;
    const target = value.trim().replace(/^\/+|\/+$/gu, "");
    if (target === "") return;
    const to = folder ? `${target}/` : target;
    if (to === from) {
      onClose();
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await writes.move({ from, to });
      onMoved?.(to);
      onClose();
    } catch (failure) {
      setError(
        apiErrorCode(failure) === "CONFLICT"
          ? t("projectFiles.renameTaken")
          : failure instanceof Error && failure.message === t("projectFiles.held")
            ? t("projectFiles.held")
            : t("projectFiles.actionFailed")
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={from !== undefined}
      title={t(folder ? "projectFiles.renameFolder" : "projectFiles.renameTitle")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} loading={pending} disabled={value.trim() === ""}>
            {t("projectFiles.renameConfirm")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-3"
        onSubmit={(event) => {
          submit(event).catch(() => undefined);
        }}
      >
        <Field label={t("projectFiles.renameField")} hint={t("projectFiles.renameHint")}>
          <Input
            value={value}
            data-testid="project-file-move-path"
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </Field>
        {error ? <FormNotice tone="error">{error}</FormNotice> : null}
      </form>
    </Dialog>
  );
}

/**
 * One file of a project: its preview, what it is, its versions with a way back to each, and the
 * writes on it. A deleted file shows its versions only, to be restored.
 */
export function ProjectFilePanel({
  projectId,
  path,
  files,
  onClose,
  onOpenPath,
  onOpenConversation
}: {
  projectId: string;
  /** The open file, `undefined` while the panel is closed. */
  path: string | undefined;
  files: ProjectFilesView | undefined;
  onClose(): void;
  /** Another path is open now, after a move. */
  onOpenPath(path: string): void;
  onOpenConversation?(conversationId: string): void;
}) {
  const { t, locale } = useTranslation();
  const client = useOptionalWorkspaceApiClient()?.client;
  const writes = useProjectFileWrites(projectId, t("projectFiles.held"));
  const [moving, setMoving] = useState<string>();
  const [confirm, setConfirm] = useState<"delete" | "purge">();
  const [pending, setPending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState<string>();
  const file = path === undefined ? undefined : files?.items.find((item) => item.path === path);
  const name = path === undefined ? "" : projectFileName(path);
  useEffect(() => setNotice(undefined), [path]);

  const failed = (error: unknown) =>
    setNotice(
      apiErrorCode(error) === "CONFLICT"
        ? t("projectFiles.changedMeanwhile")
        : error instanceof Error && error.message === t("projectFiles.held")
          ? t("projectFiles.held")
          : t("projectFiles.actionFailed")
    );

  async function run(action: "delete" | "purge") {
    if (!path) return;
    setPending(true);
    try {
      if (action === "delete") {
        await writes.remove({ path, replaces: file?.version });
      } else {
        await writes.purge({ path });
        onClose();
      }
      setConfirm(undefined);
    } catch (error) {
      setConfirm(undefined);
      failed(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Drawer
        open={path !== undefined}
        title={name}
        description={path !== undefined && path !== name ? path : undefined}
        onClose={onClose}
        className="w-[min(40rem,100vw)]"
        footer={
          path === undefined ? undefined : (
            <div className="flex flex-wrap gap-2" data-testid="project-file-actions">
              {file ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={downloading}
                    onClick={() => {
                      setDownloading(true);
                      downloadProjectFile(client, projectId, path)
                        .catch(failed)
                        .finally(() => setDownloading(false));
                    }}
                  >
                    {t("projectFiles.download")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setMoving(path)}>
                    {t("projectFiles.rename")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirm("delete")}>
                    {t("projectFiles.delete")}
                  </Button>
                </>
              ) : null}
              <Button variant="danger" size="sm" onClick={() => setConfirm("purge")}>
                {t("projectFiles.purge")}
              </Button>
            </div>
          )
        }
      >
        {path === undefined ? null : (
          <div className="grid gap-5" data-testid="project-file-panel">
            {notice ? <FormNotice tone="error">{notice}</FormNotice> : null}
            {file ? (
              <>
                <ProjectFilePreview projectId={projectId} file={file} />
                <KeyValueList>
                  <KeyValue label={t("projectFiles.detailsSize")}>
                    {formatProjectBytes(file.byteSize, locale)}
                  </KeyValue>
                  <KeyValue label={t("projectFiles.detailsType")}>{file.mimeType}</KeyValue>
                  <KeyValue label={t("projectFiles.detailsChanged")}>
                    {formatDateTime(file.updatedAt, locale)} ·{" "}
                    {t("projectFiles.version", { version: file.version })}
                  </KeyValue>
                  <KeyValue label={t("projectFiles.detailsBy")}>
                    {file.updatedBy?.label ?? t("projectFiles.formerMember")}
                  </KeyValue>
                </KeyValueList>
              </>
            ) : files ? (
              <EmptyState>{t("projectFiles.deletedFile")}</EmptyState>
            ) : (
              <Spinner />
            )}
            <section className="grid gap-2">
              <h3 className="text-label font-medium">{t("projectFiles.versions")}</h3>
              <ProjectFileVersions
                projectId={projectId}
                path={path}
                onOpenConversation={onOpenConversation}
                onFailed={setNotice}
              />
            </section>
          </div>
        )}
      </Drawer>
      <ProjectFileMoveDialog
        projectId={projectId}
        from={moving}
        onClose={() => setMoving(undefined)}
        onMoved={onOpenPath}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        title={t("projectFiles.deleteTitle", { name })}
        confirmLabel={t("projectFiles.delete")}
        loading={pending}
        onConfirm={() => {
          run("delete").catch(() => undefined);
        }}
        onClose={() => setConfirm(undefined)}
      >
        {t("projectFiles.deleteBody")}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "purge"}
        title={t("projectFiles.purgeTitle", { name })}
        confirmLabel={t("projectFiles.purge")}
        loading={pending}
        onConfirm={() => {
          run("purge").catch(() => undefined);
        }}
        onClose={() => setConfirm(undefined)}
      >
        {t("projectFiles.purgeBody")}
      </ConfirmDialog>
    </>
  );
}
