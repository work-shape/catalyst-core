import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { Maximize2, MessageSquare, Minimize2, X } from "lucide-react";
import {
  Button,
  cn,
  EmptyState,
  IconButton,
  SplitHandle,
  SurfaceFrame,
  useExit
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { useToolDisplayPanel } from "../tools/tool-display-panel";
import { readStoredSurfaceWidth, writeStoredSurfaceWidth } from "../../shared/workspace-utils";
import type { Surface, SurfaceKind } from "./surface";
import { announcePanelMove } from "./panel-move";
import {
  clampSurfaceWidth,
  defaultSurfaceWidth,
  maxSurfaceWidth,
  surfacePlacement
} from "./surface-layout";
import { useSplitArea } from "./use-split-area";
import { renderSurface, surfaceRenderers, type SurfaceRenderers } from "./surface-renderers";

/**
 * How the slot shows its surface: `beside` the conversation, `covering` the main area because
 * both sides would not fit, or `fullscreen` over the whole window.
 */
export type SurfaceSlotMode = "beside" | "covering" | "fullscreen";

/** Where an area's slot takes its surface from when the area holds it itself, as a route does. */
export interface SurfaceSlotSource {
  surface: Surface | undefined;
  close(): void;
}

/** What lies under a surface that covers the main area: the button that brings it back. */
export interface SurfaceSlotUnder {
  label: string;
  icon: ReactNode;
}

/** What the slot shows beside the main side while it holds no surface. */
export interface SurfaceSlotIdle {
  /** The kind whose width the empty slot takes, so opening a surface moves nothing. */
  kind: SurfaceKind;
  content: ReactNode;
}

/**
 * The one place a surface is shown. It sits beside the conversation while both sides keep their
 * minimum, and covers the main area below that. Its width is free, is kept per surface kind and
 * is never a property: a slice that adds a kind adds a renderer, not a mount and not a width.
 *
 * A surface comes in from the right edge and leaves to it. The conversation takes its new width
 * in the frame the surface opens or closes and moves to its new place meanwhile (`panel-move`),
 * so opening and closing are one movement and the text wraps once. A slot with an `idle` state
 * is always there and moves nothing.
 */
export function SurfaceSlot({
  renderers = surfaceRenderers,
  source,
  under,
  idle,
  covers = false,
  onBesideWidthChange,
  onCoveringChange
}: {
  renderers?: SurfaceRenderers;
  /** The surface of an area that holds it itself. Without it the slot shows what a card opened. */
  source?: SurfaceSlotSource;
  /** What the surface covers. Without it that is the chat. */
  under?: SurfaceSlotUnder;
  /** Shown beside the main side while there is no surface. Without it the empty slot is gone. */
  idle?: SurfaceSlotIdle;
  /**
   * The surface covers the area the slot stands in at any width, as over the page beside the
   * dock, where the conversation is elsewhere.
   */
  covers?: boolean;
  /** Told how much of the main area the slot takes beside the conversation; 0 otherwise. */
  onBesideWidthChange?: (width: number) => void;
  /** Told whether the surface covers the main area, so what lies under it can go inert. */
  onCoveringChange?: (covering: boolean) => void;
}) {
  const panel = useToolDisplayPanel();
  const { t } = useTranslation();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // The main area is what the slot shares with the conversation: the element it stands in.
  const { mainWidth, splitMin } = useSplitArea(slot, "parent");
  // The widths chosen since the page loaded. Before that a kind's width comes from storage.
  const [chosenWidths, setChosenWidths] = useState<Partial<Record<SurfaceKind, number>>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const surface = source ? source.surface : panel.entry && panel.open ? panel.entry : undefined;
  const placement = covers ? "covering" : surfacePlacement(mainWidth, splitMin);
  // An empty slot shows only where it would stand beside the main side.
  const idleContent =
    !surface && idle && mainWidth !== undefined && placement === "beside" ? idle : undefined;
  // A surface that closes beside the conversation or over it is held while it leaves to the
  // right edge. One that closes from fullscreen, or gives its place to the empty slot, is gone
  // at once.
  const exit = useExit(
    useMemo(() => (surface ? { surface, fullscreen } : undefined), [surface, fullscreen])
  );
  const leavingSurface =
    exit.leaving && !exit.held?.fullscreen && !idle ? exit.held?.surface : undefined;
  const framedSurface = surface ?? leavingSurface;
  const kind = framedSurface?.kind ?? idleContent?.kind;
  const shown = Boolean(surface) || idleContent !== undefined;
  const maximumWidth = maxSurfaceWidth(mainWidth, splitMin);
  const storedWidth = useMemo(
    () =>
      kind === undefined || typeof window === "undefined"
        ? undefined
        : readStoredSurfaceWidth(kind, { min: splitMin, max: maximumWidth }),
    [kind, maximumWidth, splitMin]
  );
  // The width a kind opens at is taken from the main area as it is when the slot opens, and
  // held while it stays open: a window that is resized moves the split, not the surface.
  const [opened, setOpened] = useState<{ kind: SurfaceKind; width: number } | undefined>();
  if (
    kind === undefined ? opened !== undefined : mainWidth !== undefined && opened?.kind !== kind
  ) {
    setOpened(
      kind === undefined ? undefined : { kind, width: defaultSurfaceWidth(kind, mainWidth) }
    );
  }
  const width = clampSurfaceWidth(
    (kind === undefined ? undefined : (chosenWidths[kind] ?? storedWidth)) ??
      opened?.width ??
      defaultSurfaceWidth(kind, mainWidth),
    mainWidth,
    splitMin
  );
  const mode: SurfaceSlotMode =
    placement === "covering" ? "covering" : fullscreen ? "fullscreen" : "beside";
  const besideWidth = shown && mode === "beside" ? width : 0;
  // Fullscreen hides the conversation as much as a narrow main area does.
  const covering = Boolean(surface) && mode !== "beside";

  // The reader closes the surface on the surface, so the focus goes back to what opened it.
  const closeSource = source?.close;
  const closePanel = panel.close;
  const closeSurface = useCallback(() => {
    setFullscreen(false);
    if (closeSource) {
      closeSource();
    } else {
      closePanel({ restoreFocus: true });
    }
  }, [closePanel, closeSource]);

  const chooseWidth = useCallback(
    (nextWidth: number) => {
      if (kind !== undefined) {
        setChosenWidths((current) => ({ ...current, [kind]: nextWidth }));
      }
    },
    [kind]
  );
  const keepWidth = useCallback(
    (chosen: number) => {
      if (kind !== undefined) {
        writeStoredSurfaceWidth(kind, chosen);
      }
    },
    [kind]
  );

  useEffect(() => {
    if (!surface) {
      return undefined;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // Escape closes the topmost layer first: a menu has taken the key already, and a dialog,
      // the palette or the drawer is about to.
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        document.querySelector("dialog:modal") !== null
      ) {
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

  // Told before the frame is painted, so the header beside the surface ends with it at once.
  useLayoutEffect(() => {
    onBesideWidthChange?.(besideWidth);
  }, [besideWidth, onBesideWidthChange]);

  useLayoutEffect(() => {
    onCoveringChange?.(covering);
  }, [covering, onCoveringChange]);

  // What stands beside the slot moves with it when it opens, closes or changes its kind, and
  // with nothing else: not with a drag of the split and not with the window.
  const besideKind = shown && mode === "beside" ? kind : undefined;
  const besideKindBefore = useRef(besideKind);
  useLayoutEffect(() => {
    if (besideKindBefore.current !== besideKind) {
      besideKindBefore.current = besideKind;
      announcePanelMove(besideKind === undefined ? "close" : "open");
    }
  }, [besideKind]);

  return (
    <aside
      ref={setSlot}
      hidden={!shown && !leavingSurface}
      // A surface on its way out is no longer there for the reader.
      inert={leavingSurface !== undefined}
      aria-label={surface?.title}
      data-surface-kind={surface?.kind}
      data-surface-mode={surface ? mode : undefined}
      onAnimationEnd={exit.onAnimationEnd}
      className={cn(
        "bg-card",
        mode === "beside" &&
          (leavingSurface
            ? // Out of the row, so the conversation has its full width from the first frame.
              "absolute inset-y-0 right-0 z-50 border-l"
            : "relative z-50 h-full min-h-0 shrink-0 border-l"),
        mode === "covering" && "absolute inset-0 z-50",
        mode === "fullscreen" && "fixed inset-0 z-(--layer-fullscreen)",
        // Stated for as long as the surface is shown, so it plays once: when the slot appears.
        surface && !idle && "motion-safe:animate-panel-in",
        leavingSurface && "motion-safe:animate-panel-out"
      )}
      style={mode === "beside" ? { width: `${width}px` } : undefined}
    >
      {shown && mode === "beside" && mainWidth !== undefined && kind !== undefined ? (
        // The separator's value is the conversation's width.
        <SplitHandle
          label={t("resizeDisplayPanel")}
          edge="left"
          width={width}
          min={splitMin}
          max={maximumWidth}
          value={{ now: mainWidth - width, min: splitMin, max: mainWidth - splitMin }}
          onResize={chooseWidth}
          onResizeEnd={keepWidth}
        />
      ) : null}
      {framedSurface ? (
        <SurfaceSlotFrame
          surface={framedSurface}
          renderers={renderers}
          mode={mode}
          under={under}
          onClose={closeSurface}
          onShowChat={mode === "fullscreen" ? () => setFullscreen(false) : closeSurface}
          onToggleFullscreen={() => setFullscreen((current) => !current)}
        />
      ) : (
        idleContent?.content
      )}
    </aside>
  );
}

/**
 * The frame of the surface in the slot. Beside the conversation it offers fullscreen and close.
 * In fullscreen "Show chat" joins them. Covering the main area it offers "Show chat" alone,
 * because all three would do the same thing there. An area that is not the chat names what its
 * surface covers through `under`.
 */
export function SurfaceSlotFrame({
  surface,
  renderers = surfaceRenderers,
  mode,
  under,
  onClose,
  onShowChat,
  onToggleFullscreen
}: {
  surface: Surface;
  renderers?: SurfaceRenderers;
  mode: SurfaceSlotMode;
  under?: SurfaceSlotUnder;
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
        mode === "beside" ? undefined : mode === "covering" ? (
          <IconButton label={under?.label ?? t("nav.showChat")} onClick={onShowChat}>
            {under?.icon ?? <MessageSquare aria-hidden="true" />}
          </IconButton>
        ) : (
          <Button variant="ghost" size="sm" onClick={onShowChat}>
            {under?.icon ?? <MessageSquare aria-hidden="true" />}
            {under?.label ?? t("nav.showChat")}
          </Button>
        )
      }
      icon={rendering?.titleIcon}
      title={surface.title}
      subtitle={rendering?.subtitle ?? surface.subtitle}
      actions={rendering?.actions}
      flush={rendering?.flush}
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
