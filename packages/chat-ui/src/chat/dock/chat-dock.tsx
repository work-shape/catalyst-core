import type { AnimationEvent, CSSProperties, ReactNode } from "react";
import { Maximize2, MessageSquare, PanelRight, SquarePen, X } from "lucide-react";
import {
  Badge,
  Button,
  cn,
  CountBadge,
  IconButton,
  SurfaceHeader,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { DockTab } from "./dock-try";

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

/**
 * The head of the dock: what it holds, the way to its chat route, and close. A conversation
 * about an asset is named by its agent, with the agent's mark, and the asset under it.
 */
export function DockHead({
  title,
  mark,
  subtitle,
  subjectKind,
  preview = false,
  tabs,
  over,
  onShowPage,
  onOpenFullChat,
  onNewChat,
  onClose
}: {
  title: string;
  mark?: ReactNode;
  subtitle?: string;
  /** The kind of the asset the conversation is about, where the head names it. */
  subjectKind?: string;
  /** The conversation is Try's: its head marks it "Preview". */
  preview?: boolean;
  /** Build and Try on an agent's page, under the head and joined to it. */
  tabs?: ReactNode;
  over: boolean;
  onShowPage(): void;
  /** Absent while the dock holds no conversation. */
  onOpenFullChat?: () => void;
  /** Starts a new conversation for the page; absent on Try, whose conversation is its own. */
  onNewChat?: () => void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const head = (
    <SurfaceHeader
      // Below 768 px the button that opens the sidebar floats over the head's start.
      className={cn(
        "bg-background max-md:ps-[calc(var(--layout-gutter)+var(--layout-header-control))]",
        // The tabs draw the line under the head.
        tabs !== undefined && "border-b-0"
      )}
      leading={
        over ? (
          <>
            <Button variant="ghost" size="sm" className="max-sm:hidden" onClick={onShowPage}>
              <PanelRight aria-hidden="true" />
              {t("dock.showPage")}
            </Button>
            {/* On a phone the conversation's name wins the row: the button keeps its icon. */}
            <IconButton label={t("dock.showPage")} className="sm:hidden" onClick={onShowPage}>
              <PanelRight aria-hidden="true" />
            </IconButton>
          </>
        ) : undefined
      }
      icon={mark}
      title={title}
      subtitle={subtitle}
      data-testid="dock-head"
      data-subject-kind={subjectKind}
      actions={
        preview || onOpenFullChat !== undefined || onNewChat !== undefined ? (
          <>
            {preview ? (
              <Badge tone="info" data-testid="dock-preview">
                {t("dock.preview")}
              </Badge>
            ) : null}
            {onNewChat === undefined ? null : (
              <IconButton label={t("dock.newChat")} onClick={onNewChat}>
                <SquarePen aria-hidden="true" />
              </IconButton>
            )}
            {onOpenFullChat === undefined ? null : (
              <IconButton label={t("dock.openFullChat")} onClick={onOpenFullChat}>
                <Maximize2 aria-hidden="true" />
              </IconButton>
            )}
          </>
        ) : undefined
      }
      close={
        <IconButton label={t("dock.close")} onClick={onClose}>
          <X aria-hidden="true" />
        </IconButton>
      }
    />
  );
  return tabs === undefined ? (
    head
  ) : (
    <div className="shrink-0">
      {head}
      {tabs}
    </div>
  );
}

/**
 * "Build | Try" under the dock's head on an agent's page (section 4.7c): each tab holds its own
 * conversation.
 */
export function DockTabs({ tab, onSelect }: { tab: DockTab; onSelect(tab: DockTab): void }) {
  const { t } = useTranslation();
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onSelect(value === "try" ? "try" : "build")}
      className="shrink-0 bg-background px-3 sm:px-4"
      data-testid="dock-tabs"
    >
      <TabsList label={t("dock.tabs")}>
        <TabsTrigger value="build">{t("dock.tabBuild")}</TabsTrigger>
        <TabsTrigger value="try">{t("dock.tabTry")}</TabsTrigger>
      </TabsList>
    </Tabs>
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
        // What the page pins, such as an asset's head on the sticky layer, stays inside the
        // page: the dock that lies over it covers it whole.
        // Its width is a container, so a head beside the dock can show its actions as icons.
        "@container/dock-page relative isolate h-full min-h-0 min-w-0 flex-1",
        arrival === "in" && "[--duration-loading-delay:0ms] motion-safe:animate-dock-page-in"
      )}
    >
      {children}
    </div>
  );
}

/**
 * The control every page head carries for the dock, first in its actions: "Chat" opens the dock,
 * with a dot while its answer runs; "Show chat" brings the dock in front where it lies over the
 * page. `shortcut` names the keys that do the same. In a narrow window, `compact`, "Chat" is its
 * icon alone, so the head keeps its name and actions on one row.
 */
export function DockPageAction({
  kind,
  running,
  shortcut,
  compact = false,
  onClick
}: {
  kind: "open" | "show";
  running: boolean;
  shortcut?: string;
  compact?: boolean;
  onClick(): void;
}) {
  const { t } = useTranslation();
  const label = kind === "open" ? t("dock.chat") : t("dock.showChat");
  const dot = running ? (
    <>
      <CountBadge dot aria-hidden="true" data-testid="dock-running-dot" />
      <span className="sr-only">{`, ${t("dock.answerRunning")}`}</span>
    </>
  ) : null;
  if (compact && kind === "open") {
    return (
      <IconButton
        label={label}
        variant="outline"
        onClick={onClick}
        data-testid="dock-page-action"
        {...(shortcut === undefined ? {} : { shortcut })}
      >
        <MessageSquare aria-hidden="true" />
        {dot}
      </IconButton>
    );
  }
  const button = (
    <Button variant="secondary" onClick={onClick} data-testid="dock-page-action">
      <MessageSquare aria-hidden="true" />
      {label}
      {dot}
    </Button>
  );
  if (shortcut === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent shortcut={shortcut}>{t("dock.chatHint")}</TooltipContent>
    </Tooltip>
  );
}
