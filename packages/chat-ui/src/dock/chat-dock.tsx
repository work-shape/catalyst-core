import type { AnimationEvent, CSSProperties, ReactNode } from "react";
import { Maximize2, MessageSquare, PanelRight, X } from "lucide-react";
import { Button, cn, CountBadge, IconButton, SurfaceHeader } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";

/**
 * Where the conversation stands: `main`, the chat route's main area; `dock`, the dock beside or
 * over a page; `closed`, a dock the person closed, kept laid out and unseen so its stream, text
 * and scroll position are there when it comes back.
 */
export type ChatColumnMode = "main" | "dock" | "closed";

/** The movement the shell plays itself, where the host plays no view transition. */
export type DockArrival = "in" | "out";

/**
 * The one column the conversation lives in, on the chat route and in the dock of every other
 * page. It is the same element in all of them, so a change of route never mounts the
 * conversation anew. The page stands beside it in `DockPage`.
 */
export function ChatColumn({
  mode,
  over,
  inFront,
  width,
  arrival,
  head,
  handle,
  onArrived,
  children
}: {
  mode: ChatColumnMode;
  /** The dock lies over the page, at the page's full width, because both do not fit side by side. */
  over: boolean;
  /** Where the dock lies over the page: whether it is in front. */
  inFront: boolean;
  /** The dock's width in pixels, beside the page. */
  width: number;
  /** The widening out of the dock that the column plays. */
  arrival: DockArrival | undefined;
  /** The dock's head, above the conversation. */
  head?: ReactNode;
  /** The handle that resizes the dock, at its edge to the page. */
  handle?: ReactNode;
  onArrived(): void;
  children: ReactNode;
}) {
  const hidden = mode === "closed" || (mode === "dock" && over && !inFront);
  const beside = mode !== "main" && !over;
  return (
    <div
      // The view transitions of the dock find the conversation by this mark.
      data-dock-chat=""
      data-chat-mode={mode}
      data-dock-arrival={arrival}
      inert={hidden}
      aria-hidden={hidden || undefined}
      onAnimationEnd={(event: AnimationEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) {
          onArrived();
        }
      }}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col bg-background",
        mode === "main" && "relative flex-1",
        beside && "relative shrink-0 border-r",
        // Over the page it is the page's width; the button of the sidebar still floats over it.
        mode !== "main" && over && "absolute inset-0 z-30",
        // Unseen, the column keeps its layout: its scroll position stays where the reader left it.
        hidden && "invisible",
        mode === "closed" && !over && "absolute inset-y-0 left-0",
        // The thread starts close under the dock's head; on the chat route a floating header
        // stands where the head would.
        mode !== "main" && "[--thread-start:var(--layout-gutter)]",
        arrival === "out" && "motion-safe:animate-dock-widen"
      )}
      style={beside ? { width: `${width}px` } : arrival === "out" ? widenFrom(width) : undefined}
    >
      {mode === "main" ? null : head}
      <div className="relative min-h-0 flex-1">{children}</div>
      {beside && mode === "dock" ? handle : null}
    </div>
  );
}

/** Where the conversation widens out of the dock from: the dock's width. */
function widenFrom(width: number): CSSProperties & { "--dock-from": string } {
  return { "--dock-from": `${width}px` };
}

/** The head of the dock: what it holds, the way to its chat route, and close. */
export function DockHead({
  title,
  over,
  onShowPage,
  onOpenFullChat,
  onClose
}: {
  title: string;
  over: boolean;
  onShowPage(): void;
  /** Absent while the dock holds no conversation. */
  onOpenFullChat?: () => void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <SurfaceHeader
      // Below 768 px the button that opens the sidebar floats over the head's start.
      className="bg-background max-md:ps-[calc(var(--layout-gutter)+var(--layout-header-control))]"
      leading={
        over ? (
          <Button variant="ghost" size="sm" onClick={onShowPage}>
            <PanelRight aria-hidden="true" />
            {/* On a phone the conversation's name wins the row: the button keeps its icon. */}
            <span className="max-sm:sr-only">{t("dock.showPage")}</span>
          </Button>
        ) : undefined
      }
      title={title}
      actions={
        onOpenFullChat === undefined ? undefined : (
          <IconButton label={t("dock.openFullChat")} onClick={onOpenFullChat}>
            <Maximize2 aria-hidden="true" />
          </IconButton>
        )
      }
      close={
        <IconButton label={t("dock.close")} onClick={onClose}>
          <X aria-hidden="true" />
        </IconButton>
      }
    />
  );
}

/**
 * The page beside the dock, or alone. While the conversation narrows into the dock, the page
 * comes in at the dock's moving edge and its loading layout shows at once.
 */
export function DockPage({
  covered,
  arrival,
  onArrived,
  children
}: {
  /** The dock lies over the page in front of it. */
  covered: boolean;
  arrival: DockArrival | undefined;
  onArrived(): void;
  children: ReactNode;
}) {
  return (
    <div
      data-dock-page=""
      data-dock-arrival={arrival}
      inert={covered}
      onAnimationEnd={(event: AnimationEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) {
          onArrived();
        }
      }}
      className={cn(
        "relative h-full min-h-0 min-w-0 flex-1",
        arrival === "in" && "[--duration-loading-delay:0ms] motion-safe:animate-dock-page-in"
      )}
    >
      {children}
    </div>
  );
}

/**
 * The control a page head carries for the dock: "Chat" brings back a dock the person closed,
 * with a dot while its answer runs; "Show chat" brings the dock in front where it lies over
 * the page.
 */
export function DockPageAction({
  kind,
  running,
  onClick
}: {
  kind: "reopen" | "show";
  running: boolean;
  onClick(): void;
}) {
  const { t } = useTranslation();
  return (
    <Button variant="secondary" onClick={onClick} data-testid="dock-page-action">
      <MessageSquare aria-hidden="true" />
      {kind === "reopen" ? t("dock.chat") : t("dock.showChat")}
      {running ? (
        <>
          <CountBadge dot aria-hidden="true" data-testid="dock-running-dot" />
          <span className="sr-only">{`, ${t("dock.answerRunning")}`}</span>
        </>
      ) : null}
    </Button>
  );
}
