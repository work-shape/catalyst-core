import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from "react";
import { X } from "lucide-react";
import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

const DEFAULT_PANEL_WIDTH = 560;
const MIN_PANEL_WIDTH = 380;
const MAX_PANEL_WIDTH = 840;
const MIN_CHAT_WIDTH = 480;

export interface ToolDisplayPanelEntry {
  key: string;
  title: string;
  subtitle?: string;
  node: ReactNode;
}

interface ToolDisplayPanelContextValue {
  available: boolean;
  entry?: ToolDisplayPanelEntry;
  open: boolean;
  show(entry: ToolDisplayPanelEntry): void;
  close(): void;
}

const defaultToolDisplayPanelContext: ToolDisplayPanelContextValue = {
  available: false,
  open: false,
  show() {},
  close() {}
};

const ToolDisplayPanelContext = createContext<ToolDisplayPanelContextValue>(defaultToolDisplayPanelContext);

export function ToolDisplayPanelProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<ToolDisplayPanelEntry | undefined>();
  const [open, setOpen] = useState(false);

  const show = useCallback((nextEntry: ToolDisplayPanelEntry) => {
    setEntry(nextEntry);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setEntry(undefined);
  }, []);

  const value = useMemo<ToolDisplayPanelContextValue>(
    () => ({
      available: true,
      entry,
      open,
      show,
      close
    }),
    [close, entry, open, show]
  );

  return <ToolDisplayPanelContext.Provider value={value}>{children}</ToolDisplayPanelContext.Provider>;
}

export function useToolDisplayPanel(): ToolDisplayPanelContextValue {
  return useContext(ToolDisplayPanelContext);
}

export function ToolDisplayPanel({ className }: { className?: string }) {
  const { close, entry, open } = useToolDisplayPanel();
  const { t } = useTranslation();
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [resizing, setResizing] = useState(false);
  const visible = Boolean(entry && open);
  const clampedPanelWidth = clampPanelWidth(panelWidth);
  const panelWidthStyle = useMemo<CSSProperties>(
    () => ({
      width: visible ? `${clampedPanelWidth}px` : "0rem"
    }),
    [clampedPanelWidth, visible]
  );
  const innerWidthStyle = useMemo<CSSProperties>(
    () => ({
      width: `${clampedPanelWidth}px`
    }),
    [clampedPanelWidth]
  );

  const onResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = clampedPanelWidth;
      const target = event.currentTarget;
      setResizing(true);
      target.setPointerCapture(event.pointerId);

      function onPointerMove(moveEvent: globalThis.PointerEvent) {
        const nextWidth = startWidth + startX - moveEvent.clientX;
        setPanelWidth(clampPanelWidth(nextWidth));
      }

      function onPointerUp(upEvent: globalThis.PointerEvent) {
        setResizing(false);
        if (target.hasPointerCapture(upEvent.pointerId)) {
          target.releasePointerCapture(upEvent.pointerId);
        }
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [clampedPanelWidth]
  );

  const onResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    setPanelWidth((currentWidth) =>
      clampPanelWidth(currentWidth + (event.key === "ArrowLeft" ? 24 : -24))
    );
  }, []);

  return (
    <>
      <aside
        aria-hidden={!visible}
        inert={!visible ? true : undefined}
        className={cn(
          "relative hidden h-full min-h-0 shrink-0 overflow-hidden border-l bg-card opacity-0 lg:block",
          resizing
            ? "transition-[opacity,border-color] duration-150"
            : "transition-[width,opacity,border-color] duration-300 ease-out",
          visible ? "border-border opacity-100" : "pointer-events-none border-transparent",
          className
        )}
        style={panelWidthStyle}
      >
        {visible ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("resizeDisplayPanel")}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={maxPanelWidth()}
            aria-valuenow={clampedPanelWidth}
            tabIndex={0}
            className={cn(
              "absolute inset-y-0 left-0 z-10 hidden w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center lg:flex",
              "before:h-12 before:w-1 before:rounded-full before:bg-border before:transition-colors hover:before:bg-ring",
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
            )}
            onPointerDown={onResizePointerDown}
            onKeyDown={onResizeKeyDown}
          />
        ) : null}
        <ToolDisplayPanelFrame entry={entry} onClose={close} style={innerWidthStyle} />
      </aside>

      <button
        type="button"
        aria-label={t("closeDisplayPanel")}
        aria-hidden={!visible}
        tabIndex={visible ? 0 : -1}
        className={cn(
          "fixed inset-0 z-[55] bg-black/30 opacity-0 backdrop-blur-[1px] transition-opacity duration-300 lg:hidden",
          visible ? "pointer-events-auto opacity-100" : "pointer-events-none"
        )}
        onClick={close}
      />
      <aside
        aria-hidden={!visible}
        inert={!visible ? true : undefined}
        className={cn(
          "fixed inset-y-0 right-0 z-[60] w-[min(32rem,calc(100vw-1rem))] overflow-hidden border-l bg-card shadow-xl transition-transform duration-300 ease-out lg:hidden",
          visible ? "translate-x-0" : "pointer-events-none translate-x-full"
        )}
      >
        <ToolDisplayPanelFrame entry={entry} onClose={close} />
      </aside>
    </>
  );
}

function ToolDisplayPanelFrame({
  entry,
  onClose,
  style
}: {
  entry: ToolDisplayPanelEntry | undefined;
  onClose: () => void;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col bg-card text-card-foreground" style={style}>
      <div className="flex min-h-14 items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{entry?.title ?? t("displayPanelFallbackTitle")}</p>
          {entry?.subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{entry.subtitle}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={t("closeDisplayPanel")}
          title={t("closeDisplayPanel")}
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          )}
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto bg-background p-4 lg:p-5">
        {entry?.node}
      </div>
    </div>
  );
}

function clampPanelWidth(width: number): number {
  return Math.round(Math.min(Math.max(width, MIN_PANEL_WIDTH), maxPanelWidth()));
}

function maxPanelWidth(): number {
  if (typeof window === "undefined") {
    return MAX_PANEL_WIDTH;
  }
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - MIN_CHAT_WIDTH));
}
