import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { ApiError, type PageSourceFileEntryResponse } from "@vivd-catalyst/api-client";
import {
  Badge,
  Button,
  cn,
  CodeBlock,
  EmptyState,
  List,
  ListRow,
  SkeletonList
} from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { useTranslation } from "../i18n";

type SourceFile = Pick<PageSourceFileEntryResponse, "path" | "sha256">;

/**
 * The files a revision changed: those the revision before it did not hold, or held with other
 * content. The first revision changed nothing, it brought every file.
 */
export function changedSourcePaths(
  files: readonly SourceFile[],
  previous: readonly SourceFile[] | undefined
): Set<string> {
  if (!previous) {
    return new Set();
  }
  const before = new Map(previous.map((file) => [file.path, file.sha256]));
  return new Set(
    files.filter((file) => before.get(file.path) !== file.sha256).map((file) => file.path)
  );
}

/** Where a Page starts, in the order a reader would look for it. */
const ENTRY_PATHS = ["src/routes/index.tsx", "index.html"];

/**
 * The file that is open before the reader chose one: the first one the revision changed, the
 * manifest last, because an edit rarely means it. Without a change, where the Page starts.
 */
export function defaultOpenPath(
  files: readonly SourceFile[],
  changed: ReadonlySet<string>
): string | undefined {
  const edited = files.filter((file) => changed.has(file.path)).map((file) => file.path);
  return (
    edited.find((path) => path !== "app.yaml") ??
    edited[0] ??
    ENTRY_PATHS.find((path) => files.some((file) => file.path === path)) ??
    files[0]?.path
  );
}

/** The source files of one revision, read-only, with one of them open. */
export function PageFiles({
  conversationId,
  pageId,
  fileSetId,
  previousFileSetId,
  historyKnown
}: {
  conversationId: string;
  pageId: string;
  fileSetId: string;
  /** The revision before this one, when there is one. */
  previousFileSetId: string | undefined;
  /** Whether it is known yet that there is a revision before this one. */
  historyKnown: boolean;
}) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const [chosen, setChosen] = useState<string | undefined>();
  const [listShown, setListShown] = useState(false);
  const base = ["pages", apiBaseUrl, conversationId, pageId, "files"] as const;
  // A revision never changes, so its files are asked for once.
  const kept = { staleTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false };
  const list = useQuery({
    queryKey: [...base, fileSetId],
    queryFn: () => client.pages.files.list({ params: { conversationId, pageId, fileSetId } }),
    ...kept
  });
  const previous = useQuery({
    queryKey: [...base, previousFileSetId],
    queryFn: () =>
      client.pages.files.list({
        params: { conversationId, pageId, fileSetId: previousFileSetId ?? "" }
      }),
    enabled: previousFileSetId !== undefined,
    ...kept
  });
  const comparing = !historyKnown || (previousFileSetId !== undefined && previous.isPending);
  const files = list.data?.files;
  const changed = changedSourcePaths(files ?? [], previous.data?.files);
  const open = chosen ?? (comparing || !files ? undefined : defaultOpenPath(files, changed));
  const file = useQuery({
    queryKey: [...base, fileSetId, "file", open],
    queryFn: () =>
      client.pages.files.get({
        params: { conversationId, pageId, fileSetId },
        query: { path: open ?? "" }
      }),
    enabled: open !== undefined,
    retry: false,
    ...kept
  });

  return (
    <PageFilesView
      files={list.isError ? "failed" : comparing || !files ? "loading" : files}
      changed={changed}
      open={open}
      content={
        file.data
          ? { status: "ready", text: file.data.text }
          : file.error instanceof ApiError && file.error.code === "VALIDATION_FAILED"
            ? { status: "not-text" }
            : file.isError
              ? { status: "failed" }
              : { status: "loading" }
      }
      listShown={listShown}
      onOpen={(path) => {
        setChosen(path);
        setListShown(false);
      }}
      onShowList={() => setListShown(true)}
    />
  );
}

type FileContent =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "not-text" }
  | { status: "ready"; text: string };

/**
 * The list of files beside the open file. Where the surface is too narrow for both, the file
 * stands alone under a line that leads back to the list.
 */
export function PageFilesView({
  files,
  changed,
  open,
  content,
  listShown,
  onOpen,
  onShowList
}: {
  files: readonly SourceFile[] | "loading" | "failed";
  changed: ReadonlySet<string>;
  open: string | undefined;
  content: FileContent;
  /** In a narrow surface: the list is shown in place of the file. */
  listShown: boolean;
  onOpen(path: string): void;
  onShowList(): void;
}) {
  const { t } = useTranslation();
  if (files === "loading") {
    return <SkeletonList rows={4} className="p-4" />;
  }
  if (files === "failed") {
    return (
      <EmptyState layout="inline" className="p-4">
        {t("pages.filesFailed")}
      </EmptyState>
    );
  }
  if (files.length === 0 || open === undefined) {
    return (
      <EmptyState layout="inline" className="p-4">
        {t("pages.filesEmpty")}
      </EmptyState>
    );
  }
  return (
    <div className="@container h-full min-h-0">
      <div className="grid h-full min-h-0 grid-cols-1 grid-rows-1 @lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav
          aria-label={t("pages.filesList")}
          className={cn(
            "min-h-0 overflow-y-auto bg-card p-2 pb-(--layout-page-end) @lg:block @lg:border-r",
            !listShown && "hidden"
          )}
        >
          <List>
            {files.map((file) => (
              <ListRow
                key={file.path}
                size="compact"
                title={<span className="font-mono text-code">{file.path}</span>}
                chips={
                  changed.has(file.path) ? (
                    <Badge size="sm" tone="info">
                      {t("pages.fileChanged")}
                    </Badge>
                  ) : undefined
                }
                selected={file.path === open}
                onClick={() => onOpen(file.path)}
              />
            ))}
          </List>
        </nav>
        <div className={cn("min-h-0 min-w-0 flex-col @lg:flex", listShown ? "hidden" : "flex")}>
          <div className="flex shrink-0 items-center gap-2 border-b bg-card px-2 py-1 @lg:hidden">
            <Button variant="ghost" size="sm" onClick={onShowList}>
              <ChevronLeft aria-hidden="true" />
              {t("pages.showFileList")}
            </Button>
            <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
              {open}
            </span>
          </div>
          {content.status === "ready" ? (
            <CodeBlock
              className="min-h-0 flex-1 rounded-none border-0"
              label={open}
              code={content.text}
            />
          ) : content.status === "loading" ? (
            <SkeletonList rows={6} className="p-4" />
          ) : (
            <EmptyState layout="inline" className="p-4">
              {t(content.status === "not-text" ? "pages.fileNotText" : "pages.filesFailed")}
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
