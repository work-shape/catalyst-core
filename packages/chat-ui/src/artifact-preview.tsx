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
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";
import type { ApiClient } from "@vivd-catalyst/api-client";
import { renderAsync as renderDocxAsync } from "docx-preview";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  LiveArtifactPreview,
  shouldUseLiveArtifactPreviewState as shouldUseLiveArtifactPreviewStateValue
} from "./artifact-preview-live";
import { ArtifactPreviewFrame, ArtifactPreviewMessage } from "./artifact-preview-shell";
import { useTranslation } from "./i18n";
import { MarkdownArtifact } from "./markdown-text";
import {
  workbookToUniverPreview,
  type SpreadsheetWorkbookPreview
} from "./spreadsheet-preview";
import {
  SPREADSHEET_VISUAL_COMPONENT,
  SpreadsheetVisualLayer
} from "./spreadsheet-visual-layer";
import type { SpreadsheetVisual, SpreadsheetVisualAnchor } from "./spreadsheet-visuals";
import { Spinner } from "./ui/spinner";
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
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; blob: Blob; url: string }
    | { status: "failed"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ status: "loading" });
    void client
      .conversationArtifactContent(conversationId, artifact.artifactId)
      .then((blob) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", blob, url: objectUrl });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "failed",
            message: error instanceof Error ? error.message : t("artifactPreviewFailed")
          });
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [artifact.artifactId, client, conversationId, previewKind, t]);

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
        detail={state.message}
      />
    );
  }

  if (previewKind === "spreadsheet") {
    return <SpreadsheetFilePreview blob={state.blob} />;
  }

  return (
    <ArtifactPreviewFrame>
      {previewKind === "pdf" ? (
        <iframe title={artifactDisplayFilename(artifact)} src={state.url} className="h-full w-full border-0" />
      ) : null}
      {previewKind === "image" ? (
        <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 p-4">
          <img
            src={state.url}
            alt={artifactDisplayFilename(artifact)}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ) : null}
      {previewKind === "markdown" ? <MarkdownArtifactPreview blob={state.blob} /> : null}
      {previewKind === "text" ? <TextArtifactPreview blob={state.blob} /> : null}
      {previewKind === "document" ? <DocumentArtifactPreview blob={state.blob} fileType={fileType} /> : null}
      {previewKind === "presentation" ? (
        <PresentationArtifactPreview blob={state.blob} fileType={fileType} />
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

function DocumentArtifactPreview({ blob, fileType }: { blob: Blob; fileType: ArtifactFileType }) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fitViewportRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    let cancelled = false;
    let settled = false;
    let styleContainer: HTMLDivElement | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const failPreview = (message: string) => {
      if (cancelled || settled) {
        return;
      }
      settled = true;
      setError(message);
      setLoading(false);
    };
    const timeout = window.setTimeout(() => {
      failPreview(t("artifactPreviewUnavailable"));
    }, 12_000);
    container.replaceChildren();
    styleContainer = document.createElement("div");
    styleContainer.hidden = true;
    container.after(styleContainer);
    setLoading(true);
    setError(undefined);
    void renderDocxAsync(blob, container, styleContainer, {
      breakPages: true,
      className: "artifact-docx",
      experimental: false,
      ignoreFonts: false,
      ignoreHeight: false,
      ignoreLastRenderedPageBreak: false,
      ignoreWidth: false,
      inWrapper: true,
      renderComments: false,
      renderEndnotes: true,
      renderFooters: true,
      renderFootnotes: true,
      renderHeaders: true,
      useBase64URL: true
    })
      .then(() => {
        window.clearTimeout(timeout);
        if (cancelled || settled) {
          return;
        }
        if (!hasRenderedDocxContent(container)) {
          failPreview(t("artifactPreviewUnavailable"));
          return;
        }
        normalizeDocxLayout(container);
        resizeObserver = observeDocxFit(container, fitViewportRef.current);
        settled = true;
        setLoading(false);
      })
      .catch((value: unknown) => {
        window.clearTimeout(timeout);
        failPreview(value instanceof Error ? value.message : t("artifactPreviewFailed"));
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      resizeObserver?.disconnect();
      container.replaceChildren();
      styleContainer?.remove();
    };
  }, [blob, t]);

  if (error) {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewFailed")}
        detail={error}
      />
    );
  }

  return (
    <div ref={scrollRef} className="chat-scrollbar relative h-full overflow-auto bg-slate-100">
      {loading ? (
        <div className="absolute inset-x-0 top-8 z-10 flex justify-center">
          <div className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground shadow-xs">
            <Spinner size="sm" />
            <span>{t("artifactPreviewLoading")}</span>
          </div>
        </div>
      ) : null}
      <div ref={fitViewportRef} className="min-w-0 px-6 py-6">
        <div
          ref={containerRef}
          className="mx-auto w-fit max-w-full [&_.artifact-docx-wrapper]:!bg-transparent [&_.artifact-docx-wrapper]:!p-0 [&_.docx-wrapper]:!bg-transparent [&_.docx-wrapper]:!p-0"
        />
      </div>
    </div>
  );
}

function hasRenderedDocxContent(container: HTMLElement): boolean {
  return Boolean(
    container.textContent?.trim() ||
      container.querySelector("img, svg, table, canvas, object, embed")
  );
}

function observeDocxFit(container: HTMLElement, viewport: HTMLElement | null): ResizeObserver | undefined {
  fitDocxToViewport(container, viewport);
  if (!viewport || typeof ResizeObserver === "undefined") {
    return undefined;
  }
  const resizeObserver = new ResizeObserver(() => fitDocxToViewport(container, viewport));
  resizeObserver.observe(viewport);
  resizeObserver.observe(container);
  return resizeObserver;
}

function fitDocxToViewport(container: HTMLElement, viewport: HTMLElement | null): void {
  const wrapper = docxWrapperElement(container);
  if (!wrapper || !viewport) {
    return;
  }
  wrapper.style.zoom = "1";
  const availableWidth = contentBoxWidth(viewport);
  const naturalWidth = wrapper.scrollWidth;
  if (availableWidth <= 0 || naturalWidth <= 0) {
    return;
  }
  const scale = Math.min(1, availableWidth / naturalWidth);
  wrapper.style.zoom = String(scale);
}

function normalizeDocxLayout(container: HTMLElement): void {
  const wrapper = docxWrapperElement(container);
  if (wrapper) {
    wrapper.style.setProperty("background", "transparent", "important");
    wrapper.style.setProperty("padding", "0", "important");
  }
  for (const page of container.querySelectorAll<HTMLElement>(".artifact-docx, .docx")) {
    page.style.setProperty("margin", "0 auto 1.5rem", "important");
    page.style.setProperty("box-shadow", "0 1px 4px rgb(15 23 42 / 0.18)", "important");
  }
}

function docxWrapperElement(container: HTMLElement): HTMLElement | undefined {
  return (
    container.querySelector<HTMLElement>(".artifact-docx-wrapper") ??
    container.querySelector<HTMLElement>(".docx-wrapper") ??
    (container.firstElementChild instanceof HTMLElement ? container.firstElementChild : undefined)
  );
}

function contentBoxWidth(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  return element.clientWidth - paddingLeft - paddingRight;
}

function PresentationArtifactPreview({ blob, fileType }: { blob: Blob; fileType: ArtifactFileType }) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fitViewportRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    let cancelled = false;
    let viewer: PptxViewer | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const abortController = new AbortController();
    container.replaceChildren();
    setLoading(true);
    setError(undefined);

    void blob
      .arrayBuffer()
      .then((buffer) =>
        PptxViewer.open(buffer, container, {
          fitMode: "contain",
          lazyMedia: true,
          lazySlides: true,
          listOptions: {
            batchSize: 4,
            initialSlides: 4,
            overscanViewport: 1,
            windowed: true
          },
          pdfjs: false,
          scrollContainer: scrollRef.current ?? undefined,
          signal: abortController.signal,
          zipLimits: RECOMMENDED_ZIP_LIMITS
        })
      )
      .then((nextViewer) => {
        if (cancelled) {
          nextViewer.destroy();
          return;
        }
        viewer = nextViewer;
        resizeObserver = observeElementFit(container, fitViewportRef.current);
        setLoading(false);
      })
      .catch((value: unknown) => {
        if (!cancelled) {
          setError(value instanceof Error ? value.message : t("artifactPreviewFailed"));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      abortController.abort();
      resizeObserver?.disconnect();
      viewer?.destroy();
      container.replaceChildren();
    };
  }, [blob, t]);

  if (error) {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewFailed")}
        detail={error}
      />
    );
  }

  return (
    <div ref={scrollRef} className="chat-scrollbar relative h-full overflow-auto bg-slate-100">
      {loading ? (
        <div className="absolute inset-x-0 top-8 z-10 flex justify-center">
          <div className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground shadow-xs">
            <Spinner size="sm" />
            <span>{t("artifactPreviewLoading")}</span>
          </div>
        </div>
      ) : null}
      <div ref={fitViewportRef} className="min-w-0 px-6 py-6">
        <div ref={containerRef} className="mx-auto min-h-full w-fit max-w-full" />
      </div>
    </div>
  );
}

function observeElementFit(element: HTMLElement, viewport: HTMLElement | null): ResizeObserver | undefined {
  fitElementToViewport(element, viewport);
  if (!viewport || typeof ResizeObserver === "undefined") {
    return undefined;
  }
  const resizeObserver = new ResizeObserver(() => fitElementToViewport(element, viewport));
  resizeObserver.observe(viewport);
  resizeObserver.observe(element);
  return resizeObserver;
}

function fitElementToViewport(element: HTMLElement, viewport: HTMLElement | null): void {
  if (!viewport) {
    return;
  }
  element.style.zoom = "1";
  const availableWidth = contentBoxWidth(viewport);
  const naturalWidth = element.scrollWidth;
  if (availableWidth <= 0 || naturalWidth <= 0) {
    return;
  }
  element.style.zoom = String(Math.min(1, availableWidth / naturalWidth));
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
      {text === undefined ? t("artifactPreviewLoading") : <MarkdownArtifact>{text}</MarkdownArtifact>}
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
        fileType={{ badge: "XLS", label: "Spreadsheet", className: "bg-emerald-700", extension: "xlsx" }}
        title={t("artifactPreviewFailed")}
        detail={error}
      />
    );
  }

  if (!preview) {
    return (
      <ArtifactPreviewMessage
        fileType={{ badge: "XLS", label: "Spreadsheet", className: "bg-emerald-700", extension: "xlsx" }}
        title={t("artifactPreviewLoading")}
      />
    );
  }

  return (
    <UniverReadOnlyWorkbook
      visuals={preview.visuals}
      workbookData={preview.workbookData}
    />
  );
}

function UniverReadOnlyWorkbook({
  workbookData,
  visuals
}: {
  workbookData: IWorkbookData;
  visuals: SpreadsheetVisual[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

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
    const componentDisposable = univerAPI.registerComponent(
      SPREADSHEET_VISUAL_COMPONENT,
      SpreadsheetVisualLayer
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
  }, [visuals, workbookData]);

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
  const width = anchor.width
    ?? sheetSpan(
      sheet.columnData,
      sheet.defaultColumnWidth ?? 88,
      anchor.startColumn,
      anchor.endColumn + 1
    );
  const height = anchor.height
    ?? sheetSpan(
      sheet.rowData,
      sheet.defaultRowHeight ?? 24,
      anchor.startRow,
      anchor.endRow + 1
    );
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
    size += item?.hd === BooleanNumber.TRUE ? 0 : item?.h ?? item?.w ?? defaultSize;
  }
  return size;
}

function blockSpreadsheetEditingKeys(event: KeyboardEvent<HTMLDivElement>) {
  if ((event.metaKey || event.ctrlKey) && ["a", "c", "f"].includes(event.key.toLowerCase())) {
    return;
  }
  if (
    event.key.length === 1 ||
    ["Backspace", "Delete", "Enter", "F2"].includes(event.key)
  ) {
    event.preventDefault();
  }
}
