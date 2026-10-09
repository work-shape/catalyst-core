import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import { Maximize2, MessageSquare, Minimize2, X } from "lucide-react";
import { Button, cn, EmptyState, IconButton, SurfaceFrame } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { useToolDisplayPanel } from "../tool-display-panel";
import { readStoredSurfaceWidth, writeStoredSurfaceWidth } from "../workspace-utils";
import type { Surface, SurfaceKind } from "./surface";
import {
  clampSurfaceWidth,
  DEFAULT_SURFACE_WIDTH,
  maxSurfaceWidth,
  measureSplitMin,
  SPLIT_MIN_FALLBACK_PX,
  surfaceDefaultWidths,
  surfacePlacement
} from "./surface-layout";
import { renderSurface, surfaceRenderers, type SurfaceRenderers } from "./surface-renderers";

/** How far one arrow key moves the split, in pixels. */
const SPLIT_KEY_STEP = 16;

/**
 * How the slot shows its surface: `beside` the conversation, `covering` the main area because
 * both sides would not fit, or `fullscreen` over the whole window.
 */
export type SurfaceSlotMode = "beside" | "covering" | "fullscreen";

/**
 * The one place a surface is shown. It sits beside the conversation while both sides keep their
 * minimum, and covers the main area below that. Its width is free, is kept per surface kind and
 * is never a property: a slice that adds a kind adds a renderer, not a mount and not a width.
 */
export function SurfaceSlot({
  renderers = surfaceRenderers,
  onBesideWidthChange
}: {
  renderers?: SurfaceRenderers;
  /** Told how much of the main area the surface takes beside the conversation; 0 otherwise. */
  onBesideWidthChange?: (width: number) => void;
}) {
  const { close, entry, open } = useToolDisplayPanel();
  const { t } = useTranslation();
  const slotRef = useRef<HTMLElement | null>(null);
  const [mainWidth, setMainWidth] = useState<number | undefined>();
  const [splitMin, setSplitMin] = useState(SPLIT_MIN_FALLBACK_PX);
  // The widths chosen since the page loaded. Before that a kind's width comes from storage.
  const [chosenWidths, setChosenWidths] = useState<Partial<Record<SurfaceKind, number>>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const surface = entry && open ? entry : undefined;
  const kind = surface?.kind;
  const maximumWidth = maxSurfaceWidth(mainWidth, splitMin);
  const storedWidth = useMemo(
    () =>
      kind === undefined || typeof window === "undefined"
        ? undefined
        : readStoredSurfaceWidth(kind, { min: splitMin, max: maximumWidth }),
    [kind, maximumWidth, splitMin]
  );
  const width = clampSurfaceWidth(
    (kind === undefined
      ? undefined
      : (chosenWidths[kind] ?? storedWidth ?? surfaceDefaultWidths[kind])) ?? DEFAULT_SURFACE_WIDTH,
    mainWidth,
    splitMin
  );
  const placement = surfacePlacement(mainWidth, splitMin);
  const mode: SurfaceSlotMode =
    placement === "covering" ? "covering" : fullscreen ? "fullscreen" : "beside";
  const besideWidth = surface && mode === "beside" ? width : 0;

  const closeSurface = useCallback(() => {
    setFullscreen(false);
    close();
  }, [close]);

  const chooseWidth = useCallback(
    (nextWidth: number): number | undefined => {
      if (kind === undefined) {
        return undefined;
      }
      const clamped = clampSurfaceWidth(nextWidth, mainWidth, splitMin);
      setChosenWidths((current) => ({ ...current, [kind]: clamped }));
      return clamped;
    },
    [kind, mainWidth, splitMin]
  );

  const onResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (kind === undefined) {
        return;
      }
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const target = event.currentTarget;
      let latestWidth: number | undefined;
      target.setPointerCapture(event.pointerId);

      function onPointerMove(moveEvent: globalThis.PointerEvent) {
        latestWidth = chooseWidth(startWidth + startX - moveEvent.clientX);
      }

      function onPointerUp(upEvent: globalThis.PointerEvent) {
        if (target.hasPointerCapture(upEvent.pointerId)) {
          target.releasePointerCapture(upEvent.pointerId);
        }
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        if (kind !== undefined && latestWidth !== undefined) {
          writeStoredSurfaceWidth(kind, latestWidth);
        }
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [chooseWidth, kind, width]
  );

  // The separator's value is the conversation's width, so left and Home make it smaller.
  const onResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const nextWidth =
        event.key === "ArrowLeft"
          ? width + SPLIT_KEY_STEP
          : event.key === "ArrowRight"
            ? width - SPLIT_KEY_STEP
            : event.key === "Home"
              ? maximumWidth
              : event.key === "End"
                ? splitMin
                : undefined;
      if (nextWidth === undefined || kind === undefined) {
        return;
      }
      event.preventDefault();
      const chosen = chooseWidth(nextWidth);
      if (chosen !== undefined) {
        writeStoredSurfaceWidth(kind, chosen);
      }
    },
    [chooseWidth, kind, maximumWidth, width, splitMin]
  );

  // The main area is what the slot shares with the conversation: the element it stands in.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const main = slot?.parentElement;
    if (!slot || !main) {
      return undefined;
    }
    const measure = () => {
      setMainWidth(main.getBoundingClientRect().width);
      setSplitMin(measureSplitMin(slot));
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!surface) {
      return undefined;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (mode === "fullscreen") {
        setFullscreen(false);
      } else {
        closeSurface();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSurface, mode, surface]);

  useEffect(() => {
    if (!surface) {
      setFullscreen(false);
    }
  }, [surface]);

  useEffect(() => {
    onBesideWidthChange?.(besideWidth);
  }, [besideWidth, onBesideWidthChange]);

  return (
    <aside
      ref={slotRef}
      hidden={!surface}
      aria-label={surface?.title}
      data-surface-kind={kind}
      data-surface-mode={surface ? mode : undefined}
      className={cn(
        "bg-card",
        mode === "beside" && "relative z-50 h-full min-h-0 shrink-0 border-l",
        mode === "covering" && "absolute inset-0 z-50",
        mode === "fullscreen" && "fixed inset-0 z-(--layer-fullscreen)"
      )}
      style={mode === "beside" ? { width: `${width}px` } : undefined}
    >
      {surface && mode === "beside" && mainWidth !== undefined ? (
        // The hairline between the two sides is the handle: 12 px wide to the pointer.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("resizeDisplayPanel")}
          aria-valuemin={Math.round(splitMin)}
          aria-valuemax={Math.round(mainWidth - splitMin)}
          aria-valuenow={Math.round(mainWidth - width)}
          tabIndex={0}
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-3 -translate-x-1/2 cursor-col-resize touch-none outline-none",
            "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2",
            "hover:after:bg-ring focus-visible:after:bg-ring"
          )}
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
        />
      ) : null}
      {surface ? (
        <SurfaceSlotFrame
          surface={surface}
          renderers={renderers}
          mode={mode}
          onClose={closeSurface}
          onShowChat={mode === "fullscreen" ? () => setFullscreen(false) : closeSurface}
          onToggleFullscreen={() => setFullscreen((current) => !current)}
        />
      ) : null}
    </aside>
  );
}

/**
 * The frame of the surface in the slot. Beside the conversation it offers fullscreen and close.
 * In fullscreen "Show chat" joins them. Covering the main area it offers "Show chat" alone,
 * because all three would do the same thing there.
 */
export function SurfaceSlotFrame({
  surface,
  renderers = surfaceRenderers,
  mode,
  onClose,
  onShowChat,
  onToggleFullscreen
}: {
  surface: Surface;
  renderers?: SurfaceRenderers;
  mode: SurfaceSlotMode;
  onClose: () => void;
  onShowChat: () => void;
  onToggleFullscreen: () => void;
}) {
  const { t } = useTranslation();
  const rendering = renderSurface(renderers, surface);

  return (
    <SurfaceFrame
      className="overflow-hidden"
      leading={
        mode === "beside" ? undefined : (
          <Button variant="ghost" size="sm" onClick={onShowChat}>
            <MessageSquare aria-hidden="true" />
            {t("nav.showChat")}
          </Button>
        )
      }
      title={surface.title}
      subtitle={surface.subtitle}
      actions={rendering?.actions}
      fullscreen={
        mode === "covering" ? undefined : (
          <IconButton
            label={t(mode === "fullscreen" ? "exitFullscreen" : "viewFullscreen")}
            onClick={onToggleFullscreen}
          >
            {mode === "fullscreen" ? (
              <Minimize2 aria-hidden="true" />
            ) : (
              <Maximize2 aria-hidden="true" />
            )}
          </IconButton>
        )
      }
      close={
        mode === "covering" ? undefined : (
          <IconButton label={t("closeDisplayPanel")} onClick={onClose}>
            <X aria-hidden="true" />
          </IconButton>
        )
      }
    >
      {rendering ? (
        rendering.content
      ) : (
        <EmptyState layout="inline">{t("nav.surfaceNoRenderer")}</EmptyState>
      )}
    </SurfaceFrame>
  );
}
