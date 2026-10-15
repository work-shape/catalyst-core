import {
  BooleanNumber,
  LocaleType,
  LogLevel,
  Univer,
  UniverInstanceType,
  type IWorkbookData
} from "@univerjs/core";
import { FUniver } from "@univerjs/core/facade";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import { UniverSheetsDrawingPlugin } from "@univerjs/sheets-drawing";
import { UniverSheetsDrawingUIPlugin } from "@univerjs/sheets-drawing-ui";
import "@univerjs/sheets-drawing-ui/facade";
import "@univerjs/sheets-drawing-ui/lib/index.css";
import "@univerjs/ui/facade";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SegmentedControl, SegmentedControlItem, Spinner } from "@work-shape/catalyst-ui";
import {
  LiveArtifactPreview,
  shouldUseLiveArtifactPreviewState as shouldUseLiveArtifactPreviewStateValue
} from "./artifact-preview-live";
import {
  ArtifactPreviewFrame,
  ArtifactPreviewMessage,
  NativeFilePreview
} from "./artifact-preview-shell";
import { useConversationFileBlob } from "./conversation-file-content";
import { resolveFileType } from "./file-type";
import { TranslationProvider, useTranslation } from "./i18n";
import { MarkdownArtifact } from "./markdown-text";
import { workbookToUniverPreview, type SpreadsheetWorkbookPreview } from "./spreadsheet-preview";
import { SPREADSHEET_VISUAL_COMPONENT, SpreadsheetVisualLayer } from "./spreadsheet-visual-layer";
import { StoredFileView } from "./stored-file-view";
import type { SpreadsheetVisual, SpreadsheetVisualAnchor } from "./spreadsheet-visuals";
import { RenderedHtmlDisplay } from "./rendered-html-display";
import {
  artifactDisplayFilename,
  getArtifactFileType,
  getArtifactPreviewKind,
  type ArtifactFileType,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";

export {
  ARTIFACT_PREVIEW_POLL_DELAYS_MS,
  artifactPreviewPollDelayMs,
  createArtifactPreviewView,
  createImagePagesArtifactPreviewLoadPlan,
  getArtifactSourceFallbackKind,
  shouldUseLiveArtifactPreviewState
} from "./artifact-preview-live";
export type { ArtifactPreviewView, ArtifactSourceFallbackKind } from "./artifact-preview-live";

export function ArtifactPreview({
  artifact,
  client,
  conversationId
}: {
  artifact: ToolArtifactDownloadRef;
  client: ApiClient;
  conversationId: string;
}) {
  const { t } = useTranslation();
  const previewKind = getArtifactPreviewKind(artifact);
  const fileType = getArtifactFileType(artifact);

  if (!previewKind) {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewUnavailable")}
        detail={t("artifactPreviewUnsupported")}
      />
    );
  }

  if (previewKind === "image-pages" || shouldUseLiveArtifactPreviewStateValue(artifact)) {
    return (
      <LiveArtifactPreview
        artifact={artifact}
        client={client}
        conversationId={conversationId}
        fileType={fileType}
      />
    );
  }

  if (client.browserManagedDownloads && (previewKind === "pdf" || previewKind === "image")) {
    const url = client.urlFor("conversations.artifacts.get_content", {
      params: { conversationId, artifactId: artifact.artifactId },
      query: { inline: "true" }
    });
    return (
      <NativeFilePreview kind={previewKind} title={artifactDisplayFilename(artifact)} url={url} />
    );
  }

  return (
    <BlobArtifactPreview
      artifact={artifact}
      client={client}
      conversationId={conversationId}
      fileType={fileType}
      previewKind={previewKind}
    />
  );
}

function BlobArtifactPreview({
  artifact,
  client,
  conversationId,
  fileType,
  previewKind
}: {
  artifact: ToolArtifactDownloadRef;
  client: ApiClient;
  conversationId: string;
  fileType: ArtifactFileType;
  previewKind: Exclude<ReturnType<typeof getArtifactPreviewKind>, undefined | "image-pages">;
}) {
  const { t } = useTranslation();
  const state = useConversationFileBlob({
    client,
    conversationId,
    content: { kind: "artifact", artifactId: artifact.artifactId },
    createObjectUrl: previewKind === "pdf" || previewKind === "image"
  });

  if (state.status === "loading") {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewLoading")}
        detail={artifactDisplayFilename(artifact)}
      />
    );
  }

  if (state.status === "failed") {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewFailed")}
        detail={state.error instanceof Error ? state.error.message : t("artifactPreviewFailed")}
      />
    );
  }

  if (previewKind === "spreadsheet") {
    return <SpreadsheetFilePreview blob={state.blob} />;
  }

  if ((previewKind === "pdf" || previewKind === "image") && state.url) {
    return (
      <NativeFilePreview
        kind={previewKind}
        title={artifactDisplayFilename(artifact)}
        url={state.url}
      />
    );
  }

  if (previewKind === "pdf" || previewKind === "image") {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewFailed")}
        detail={artifactDisplayFilename(artifact)}
      />
    );
  }

  return (
    <ArtifactPreviewFrame>
      {previewKind === "markdown" ? <MarkdownArtifactPreview blob={state.blob} /> : null}
      {previewKind === "text" ? (
        <TextArtifactPreview
          blob={state.blob}
          filename={artifactDisplayFilename(artifact)}
          html={isHtmlFile(artifact)}
        />
      ) : null}
    </ArtifactPreviewFrame>
  );
}

export function SpreadsheetFilePreview({ blob }: { blob: Blob }) {
  return (
    <ArtifactPreviewFrame>
      <SpreadsheetArtifactPreview blob={blob} />
    </ArtifactPreviewFrame>
  );
}

/** Whether a stored text file is an HTML page: by its type, or by what its name ends on. */
export function isHtmlFile(file: { filename?: string; mimeType?: string }): boolean {
  return (
    file.mimeType?.split(";")[0]?.trim().toLowerCase() === "text/html" ||
    /\.html?$/iu.test(file.filename ?? "")
  );
}

type TextFileView = "preview" | "source";

/**
 * A stored text file in the code view every stored file is read in. An HTML file opens as the
 * page it is, in the frame and under the policy of a generated view (view-document.ts): no
 * origin, so nothing of the app's cookies or storage, and no network. A switch shows its text.
 */
function TextArtifactPreview({
  blob,
  filename,
  html
}: {
  blob: Blob;
  filename: string;
  html: boolean;
}) {
  const { t } = useTranslation();
  const text = useBlobText(blob);
  const [view, setView] = useState<TextFileView>("preview");

  if (text === undefined) {
    return (
      <div role="status" className="flex h-full items-center justify-center">
        <Spinner size="sm" />
        <span className="sr-only">{t("artifactPreviewLoading")}</span>
      </div>
    );
  }
  if (!html) {
    return <StoredFileView className="h-full" path={filename} text={text} />;
  }
  const choice = (
    <SegmentedControl
      size="sm"
      label={t("artifactViewChoice")}
      value={view}
      onValueChange={(next) => setView(next === "source" ? "source" : "preview")}
    >
      <SegmentedControlItem value="preview">{t("artifactViewPreview")}</SegmentedControlItem>
      <SegmentedControlItem value="source">{t("artifactViewSource")}</SegmentedControlItem>
    </SegmentedControl>
  );
  if (view === "source") {
    return <StoredFileView className="h-full" path={filename} text={text} leading={choice} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="html-file-preview">
      <div className="flex min-h-control-md shrink-0 items-center gap-2 border-b bg-card px-2 py-1">
        {choice}
        <span className="min-w-0 flex-1 truncate px-2 font-mono text-caption text-muted-foreground">
          {filename}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RenderedHtmlDisplay html={text} kind="html.file" mode="side_panel" title={filename} />
      </div>
    </div>
  );
}

function MarkdownArtifactPreview({ blob }: { blob: Blob }) {
  const { t } = useTranslation();
  const text = useBlobText(blob);

  return (
    <div className="h-full overflow-auto bg-background px-5 py-6 text-foreground lg:px-7">
      {text === undefined ? (
        t("artifactPreviewLoading")
      ) : (
        <MarkdownArtifact>{text}</MarkdownArtifact>
      )}
    </div>
  );
}

function useBlobText(blob: Blob): string | undefined {
  const [text, setText] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setText(undefined);
    void blob.text().then((value) => {
      if (!cancelled) {
        setText(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [blob]);

  return text;
}

function SpreadsheetArtifactPreview({ blob }: { blob: Blob }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<SpreadsheetWorkbookPreview | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setPreview(undefined);
    setError(undefined);
    void blob
      .arrayBuffer()
      .then((buffer) => workbookToUniverPreview(buffer))
      .then((nextPreview) => {
        if (!cancelled) {
          setPreview(nextPreview);
        }
      })
      .catch((value: unknown) => {
        if (!cancelled) {
          setError(value instanceof Error ? value.message : t("artifactPreviewFailed"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [blob, t]);

  if (error) {
    return (
      <ArtifactPreviewMessage
        fileType={resolveFileType({ kind: "spreadsheet" })}
        title={t("artifactPreviewFailed")}
        detail={error}
      />
    );
  }

  if (!preview) {
    return (
      <ArtifactPreviewMessage
        fileType={resolveFileType({ kind: "spreadsheet" })}
        title={t("artifactPreviewLoading")}
      />
    );
  }

  return <UniverReadOnlyWorkbook visuals={preview.visuals} workbookData={preview.workbookData} />;
}

function UniverReadOnlyWorkbook({
  workbookData,
  visuals
}: {
  workbookData: IWorkbookData;
  visuals: SpreadsheetVisual[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { locale } = useTranslation();

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const univer = new Univer({
      locale: workbookData.locale,
      locales: {
        [LocaleType.EN_US]: enUS
      },
      logLevel: LogLevel.WARN
    });
    const preset = UniverSheetsCorePreset({
      container: containerRef.current,
      disableAutoFocus: true,
      header: false,
      toolbar: false,
      menu: {},
      contextMenu: false,
      formulaBar: true,
      footer: {
        addSheetButtonConfig: { show: false },
        menus: false,
        sheetBar: true,
        statisticBar: false,
        zoomSlider: true
      }
    });
    for (const pluginEntry of preset.plugins) {
      const [plugin, options] = Array.isArray(pluginEntry) ? pluginEntry : [pluginEntry, undefined];
      univer.registerPlugin(plugin, options as never);
    }
    univer.registerPlugin(UniverSheetsDrawingPlugin);
    univer.registerPlugin(UniverSheetsDrawingUIPlugin);
    const univerAPI = FUniver.newAPI(univer);
    // Univer renders the visuals in its own React tree, outside the chat's translations.
    const componentDisposable = univerAPI.registerComponent(
      SPREADSHEET_VISUAL_COMPONENT,
      (props: { data?: SpreadsheetVisual }) => (
        <TranslationProvider locale={locale}>
          <SpreadsheetVisualLayer {...props} />
        </TranslationProvider>
      )
    );
    const visualDisposables: Array<{ dispose: () => void }> = [];
    univer.createUnit<IWorkbookData, never>(UniverInstanceType.UNIVER_SHEET, workbookData);
    const visualTimer = window.setTimeout(() => {
      const workbook = univerAPI.getActiveWorkbook();
      for (const visual of visuals) {
        const worksheet = workbook?.getSheetByName(visual.sheetName);
        const sheetData = Object.values(workbookData.sheets).find(
          (sheet) => sheet.name === visual.sheetName
        );
        if (!worksheet || !sheetData) {
          continue;
        }
        const disposable = worksheet.addFloatDomToPosition(
          {
            allowTransform: false,
            componentKey: SPREADSHEET_VISUAL_COMPONENT,
            data: visual as never,
            initPosition: visualPosition(visual.anchor, sheetData)
          },
          visual.id
        );
        if (disposable) {
          visualDisposables.push(disposable);
        }
      }
    }, 100);

    return () => {
      window.clearTimeout(visualTimer);
      visualDisposables.forEach((disposable) => disposable.dispose());
      componentDisposable.dispose();
      univer.dispose();
    };
  }, [locale, visuals, workbookData]);

  return (
    <div
      className="h-full w-full overflow-hidden bg-white text-slate-950"
      onBeforeInput={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
      onKeyDownCapture={blockSpreadsheetEditingKeys}
      onPaste={(event) => event.preventDefault()}
      ref={containerRef}
    />
  );
}

function visualPosition(
  anchor: SpreadsheetVisualAnchor,
  sheet: Partial<NonNullable<IWorkbookData["sheets"]>[string]>
) {
  const startX = sheetSpan(sheet.columnData, sheet.defaultColumnWidth ?? 88, 0, anchor.startColumn);
  const startY = sheetSpan(sheet.rowData, sheet.defaultRowHeight ?? 24, 0, anchor.startRow);
  const width =
    anchor.width ??
    sheetSpan(
      sheet.columnData,
      sheet.defaultColumnWidth ?? 88,
      anchor.startColumn,
      anchor.endColumn + 1
    );
  const height =
    anchor.height ??
    sheetSpan(sheet.rowData, sheet.defaultRowHeight ?? 24, anchor.startRow, anchor.endRow + 1);
  return {
    startX,
    startY,
    endX: startX + width,
    endY: startY + height
  };
}

function sheetSpan(
  data: Record<number, { hd?: BooleanNumber; h?: number; w?: number }> | undefined,
  defaultSize: number,
  start: number,
  end: number
): number {
  let size = 0;
  for (let index = start; index < end; index += 1) {
    const item = data?.[index];
    size += item?.hd === BooleanNumber.TRUE ? 0 : (item?.h ?? item?.w ?? defaultSize);
  }
  return size;
}

function blockSpreadsheetEditingKeys(event: KeyboardEvent<HTMLDivElement>) {
  if ((event.metaKey || event.ctrlKey) && ["a", "c", "f"].includes(event.key.toLowerCase())) {
    return;
  }
  if (event.key.length === 1 || ["Backspace", "Delete", "Enter", "F2"].includes(event.key)) {
    event.preventDefault();
  }
}
