import { X } from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../navigation/tabs";
import { useUiLabels } from "../ui-root";

/** `float` stands over the right edge of its container, `sheet` rises from its bottom. */
export type SidePanelPlacement = "float" | "sheet";
/** `auto` is a sheet in a window under 600 px wide, or where the container says so. */
export type SidePanelMode = "auto" | SidePanelPlacement;

/**
 * A container that knows how wide it is tells the panels inside it where to stand, so a panel
 * in a narrow box of a wide window is a sheet too.
 */
export const SidePanelPlacementContext = createContext<SidePanelPlacement | undefined>(undefined);

export interface SidePanelTab {
  value: string;
  label: ReactNode;
  count?: number;
}

export interface SidePanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  open: boolean;
  /** Before the title, such as the icon tile of what the panel is about. */
  leading?: ReactNode;
  /** A small line above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** The views of the panel. The body shows the one that is chosen. */
  tabs?: readonly SidePanelTab[];
  /** Names the set of tabs for assistive technology. */
  tabsLabel?: string;
  tab?: string;
  onTabChange?(value: string): void;
  mode?: SidePanelMode;
  /** Called by the close button and by Escape while the focus is in the panel. */
  onClose(): void;
  children: ReactNode;
  /** Stays below the scrolling body, such as a SaveBar. */
  footer?: ReactNode;
  /** A form sheet uses 92% of its container height. */
  tall?: boolean;
  /** Before the close button: what can be done to the object, such as its "…" menu. */
  actions?: ReactNode;
}

const placements: Record<SidePanelMode, string> = {
  float:
    "top-3 right-3 bottom-3 w-95 max-w-[calc(100%-1.5rem)] rounded-xl border border-input slide-in-from-right-2",
  sheet: "inset-x-0 bottom-0 h-[56%] rounded-t-xl border-t slide-in-from-bottom-4",
  auto: "top-3 right-3 bottom-3 w-95 max-w-[calc(100%-1.5rem)] rounded-xl border border-input slide-in-from-right-2 max-[600px]:inset-x-0 max-[600px]:top-auto max-[600px]:bottom-0 max-[600px]:h-[56%] max-[600px]:w-auto max-[600px]:max-w-none max-[600px]:rounded-b-none max-[600px]:border-x-0 max-[600px]:border-b-0"
};

const grabbers: Record<SidePanelMode, string> = {
  float: "hidden",
  sheet: "block",
  auto: "hidden max-[600px]:block"
};

/**
 * A panel with a head, tabs and a scrolling body that stands over its container and leaves the
 * rest of it in use: it holds no focus and dims nothing. Its container is the nearest
 * positioned element. For a panel that takes the window, use a `Drawer`.
 */
export function SidePanel({
  open,
  leading,
  eyebrow,
  title,
  tabs,
  tabsLabel,
  tab,
  onTabChange,
  mode = "auto",
  onClose,
  children,
  footer,
  tall = false,
  actions,
  className,
  onKeyDown,
  ...props
}: SidePanelProps) {
  const labels = useUiLabels("SidePanel");
  const titleId = useId();
  const told = useContext(SidePanelPlacementContext);
  const placement: SidePanelMode = mode === "auto" ? (told ?? "auto") : mode;
  if (!open) {
    return null;
  }
  const close = (event: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.stopPropagation();
      onClose();
    }
  };
  const bodyClassName = "grid min-h-0 flex-1 content-start gap-3.5 overflow-y-auto p-4 text-body";
  const shownTab = tab ?? tabs?.[0]?.value;

  return (
    <aside
      aria-labelledby={titleId}
      tabIndex={-1}
      data-slot="side-panel"
      data-placement={placement}
      data-tall={tall ? "" : undefined}
      className={cn(
        "pointer-events-auto absolute z-20 flex min-h-0 animate-in flex-col overflow-hidden bg-background text-foreground shadow-overlay duration-(--duration-open) outline-none fade-in motion-reduce:animate-none",
        placements[placement],
        tall && placement === "sheet" && "h-[92%]",
        tall && placement === "auto" && "max-[600px]:h-[92%]",
        className
      )}
      onKeyDown={close}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="side-panel-grabber"
        className={cn(
          "mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-input-strong",
          grabbers[placement]
        )}
      />
      <div className="flex shrink-0 items-center gap-2.5 px-4 pt-4 pb-3">
        {leading}
        <div className="grid min-w-0 flex-1">
          {eyebrow === undefined ? null : (
            <span className="text-caption font-medium break-words text-muted-foreground">
              {eyebrow}
            </span>
          )}
          <h2 id={titleId} className="text-label break-words">
            {title}
          </h2>
        </div>
        {actions}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label={labels.close}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      {tabs === undefined || shownTab === undefined ? (
        <div data-slot="side-panel-body" className={cn(bodyClassName, "border-t")}>
          {children}
        </div>
      ) : (
        <Tabs value={shownTab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
          <TabsList label={tabsLabel ?? ""} className="shrink-0 px-1">
            {tabs.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value} count={entry.count}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={shownTab} data-slot="side-panel-body" className={bodyClassName}>
            {children}
          </TabsContent>
        </Tabs>
      )}
      {footer === undefined ? null : (
        <div data-slot="side-panel-footer" className="shrink-0 border-t bg-background">
          {footer}
        </div>
      )}
    </aside>
  );
}
