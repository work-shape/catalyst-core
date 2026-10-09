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
import type { ApiClient } from "@vivd-catalyst/api-client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Spinner } from "@vivd-catalyst/ui";
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
import { TranslationProvider, useTranslation } from "./i18n";
import { MarkdownArtifact } from "./markdown-text";
import { workbookToUniverPreview, type SpreadsheetWorkbookPreview } from "./spreadsheet-preview";
import { SPREADSHEET_VISUAL_COMPONENT, SpreadsheetVisualLayer } from "./spreadsheet-visual-layer";
import type { SpreadsheetVisual, SpreadsheetVisualAnchor } from "./spreadsheet-visuals";
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
    const url = client.conversations.artifacts.contentUrl(
      conversationId,
      artifact.artifactId,
      true
    );
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
      {previewKind === "text" ? <TextArtifactPreview blob={state.blob} /> : null}
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

function TextArtifactPreview({ blob }: { blob: Blob }) {
  const { t } = useTranslation();
  const text = useBlobText(blob);

  return (
    <pre className="chat-scrollbar h-full overflow-auto bg-background p-4 font-mono text-xs leading-5 text-foreground">
      {text ?? t("artifactPreviewLoading")}
    </pre>
  );
}

function MarkdownArtifactPreview({ blob }: { blob: Blob }) {
  const { t } = useTranslation();
  const text = useBlobText(blob);

  return (
    <div className="chat-scrollbar h-full overflow-auto bg-background px-5 py-6 text-foreground lg:px-7">
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
        fileType={{
          badge: "XLS",
          label: "Spreadsheet",
          className: "bg-emerald-700",
          extension: "xlsx"
        }}
        title={t("artifactPreviewFailed")}
        detail={error}
      />
    );
  }

  if (!preview) {
    return (
      <ArtifactPreviewMessage
        fileType={{
          badge: "XLS",
          label: "Spreadsheet",
          className: "bg-emerald-700",
          extension: "xlsx"
        }}
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
