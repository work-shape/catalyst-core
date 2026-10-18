import { Check, Clock, Minus, TriangleAlert, X } from "lucide-react";
import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "../cn";
import { Spinner } from "../feedback/spinner";
import type { UiLabels } from "../labels";
import { IconTile } from "../status/icon-tile";
import { useUiLabels } from "../ui-root";
import type { FlowEdgeState, FlowStatus } from "./flow-types";

interface StatusPresentation {
  /** The word for the status. `idle` has none. */
  label?: keyof UiLabels;
  icon: ReactNode;
  frame: string;
  badge: string;
  footerIcon: string;
}

/** How each status shows: a word, an icon, the frame's line and the corner badge's fill. */
export const flowStatusPresentations: Record<FlowStatus, StatusPresentation> = {
  idle: { icon: null, frame: "border-input", badge: "", footerIcon: "" },
  running: {
    label: "stateRunning",
    icon: <Spinner size="xs" />,
    frame: "border-info-border",
    badge: "bg-info text-info-foreground",
    footerIcon: "text-info"
  },
  waiting: {
    label: "stateWaiting",
    icon: <Clock aria-hidden="true" />,
    frame: "border-warning",
    badge: "bg-warning text-warning-foreground",
    footerIcon: "text-warning"
  },
  done: {
    label: "stateDone",
    icon: <Check aria-hidden="true" />,
    frame: "border-success-border",
    badge: "bg-success text-success-foreground",
    footerIcon: "text-success"
  },
  doneWithFailures: {
    label: "stateDoneWithFailures",
    icon: <TriangleAlert aria-hidden="true" />,
    frame: "border-warning",
    badge: "bg-warning text-warning-foreground",
    footerIcon: "text-warning"
  },
  failed: {
    label: "stateFailed",
    icon: <X aria-hidden="true" />,
    frame: "border-destructive",
    badge: "bg-destructive text-destructive-foreground",
    footerIcon: ""
  },
  skipped: {
    label: "stateSkipped",
    icon: <Minus aria-hidden="true" />,
    frame: "border-input",
    badge: "",
    footerIcon: ""
  }
};

const handleStates: Record<FlowEdgeState, string> = {
  rest: "border-input-strong",
  done: "border-success",
  active: "border-info",
  skipped: "border-input"
};

/** The classes of a handle, for the element a canvas engine draws in its place. */
export function flowHandleClassName(state: FlowEdgeState = "rest"): string {
  return cn("size-2 rounded-full border-[1.5px] bg-background", handleStates[state]);
}

export interface FlowHandleProps extends HTMLAttributes<HTMLSpanElement> {
  /** The state of the edge that meets the node here. */
  state?: FlowEdgeState;
}

/** The small circle where an edge meets a node or an exit row. It is a mark, not a control. */
export function FlowHandle({ state = "rest", className, ...props }: FlowHandleProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="flow-handle"
      data-state={state}
      className={cn("block", flowHandleClassName(state), className)}
      {...props}
    />
  );
}

/** One row of a node that has several ways out. */
export interface FlowNodeRow {
  id: string;
  label: ReactNode;
  /** Stands on the row's outer edge: the handle of the row's exit. */
  handle?: ReactNode;
}

export interface FlowHeadProps {
  icon?: ReactNode;
  accent?: boolean;
  eyebrow?: ReactNode;
  title: ReactNode;
  /** At the head's end, such as the control that folds a group. */
  end?: ReactNode;
  compact?: boolean;
}

/** The first line of a node and of a group: an icon tile, the type and the title. */
export function FlowHead({ icon, accent = false, eyebrow, title, end, compact }: FlowHeadProps) {
  return (
    <div
      data-slot="flow-head"
      className={cn("flex min-w-0 gap-2.5", compact ? "items-center" : "items-start")}
    >
      {icon === undefined ? null : (
        <IconTile data-slot="flow-tile" accent={accent} size={compact ? "lg" : "md"}>
          {icon}
        </IconTile>
      )}
      <div className="grid min-w-0 flex-1">
        {eyebrow === undefined || compact ? null : (
          <span
            data-slot="flow-eyebrow"
            className="text-caption leading-3.5 font-medium break-words text-muted-foreground"
          >
            {eyebrow}
          </span>
        )}
        <span
          data-slot="flow-title"
          className={cn(
            "min-w-0 break-words",
            compact ? "line-clamp-2 text-title-lg leading-6 font-medium" : "text-label leading-4.5"
          )}
        >
          {title}
        </span>
      </div>
      {end}
    </div>
  );
}

export interface FlowNodeProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** The icon in the tile. */
  icon?: ReactNode;
  /** The tile takes the accent. */
  accent?: boolean;
  /** The type of the node in plain words. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** One sentence on what the node does. */
  summary?: ReactNode;
  /** A small named object, with its icon before the name. */
  chip?: ReactNode;
  /** A control under the summary. */
  action?: ReactNode;
  /** One row per way out of the node. */
  rows?: readonly FlowNodeRow[];
  /** What the footer says beside the status icon. Without it the footer says the status. */
  footer?: ReactNode;
  /** At the end of the footer, such as how long it took. */
  meta?: ReactNode;
  status?: FlowStatus;
  selected?: boolean;
  /** Icon and title only, in a size that reads from far away. The frame keeps its size. */
  compact?: boolean;
  /** A second frame behind the node: it holds a graph of its own. */
  stacked?: boolean;
  /** The accessible name: the type, the title and the status in words. */
  label?: string;
  /** Called by a press, Enter and Space. With it the node takes the focus. */
  onOpen?(): void;
  /** Handles on the frame's edges, placed by whoever draws the edges. */
  handles?: ReactNode;
  frameRef?: Ref<HTMLDivElement>;
}

/**
 * The frame of one node of a graph: an icon tile, the type, a title and one sentence, then
 * what it touches, its ways out and what came of it. The status shows three times and never as
 * a colour alone: the frame's line, an icon in the corner and a word in the footer.
 */
export function FlowNode({
  icon,
  accent,
  eyebrow,
  title,
  summary,
  chip,
  action,
  rows,
  footer,
  meta,
  status = "idle",
  selected = false,
  compact = false,
  stacked = false,
  label,
  onOpen,
  handles,
  frameRef,
  className,
  onKeyDown,
  onClick,
  ...props
}: FlowNodeProps) {
  const labels = useUiLabels("FlowNode");
  const presentation = flowStatusPresentations[status];
  const statusWord = presentation.label === undefined ? undefined : labels[presentation.label];
  const skipped = status === "skipped";
  const hasRows = rows !== undefined && rows.length > 0;
  // A node with rows ends with its rows: its status is in the corner and in its name.
  const showsFooter =
    footer !== undefined || meta !== undefined || (statusWord !== undefined && !hasRows);
  const head = { icon, accent, eyebrow, title };

  // The whole anatomy stays in the frame when it is compact, hidden, so the frame keeps the
  // size a layout was made for. The compact line lies over it.
  const main = (
    <div data-slot="flow-main" className="relative">
      <div className={cn("grid min-w-0 px-3 pt-3", compact && "invisible")}>
        <FlowHead {...head} />
        {summary === undefined ? null : (
          <p data-slot="flow-summary" className="pt-1.5 text-caption text-muted-foreground">
            {summary}
          </p>
        )}
        {chip === undefined ? null : (
          <span
            data-slot="flow-chip"
            className="mt-2 inline-flex h-5.5 max-w-full min-w-0 items-center gap-1.5 justify-self-start rounded-md bg-secondary px-2 text-caption font-medium [&_svg]:size-3 [&_svg]:shrink-0"
          >
            {chip}
          </span>
        )}
        {action === undefined ? null : (
          <div
            data-slot="flow-action"
            className="mt-2 flex"
            // A press on the control is not a press on the node.
            onClick={(event) => event.stopPropagation()}
          >
            {action}
          </div>
        )}
      </div>
      {compact && hasRows ? <CompactLine {...head} /> : null}
    </div>
  );

  const open = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    // A key pressed on a control inside the node belongs to that control.
    if (event.defaultPrevented || event.target !== event.currentTarget || onOpen === undefined) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      role="group"
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      tabIndex={onOpen === undefined ? undefined : 0}
      data-slot="flow-node"
      data-status={status}
      data-selected={selected ? "" : undefined}
      data-compact={compact ? "" : undefined}
      className={cn(
        "relative isolate w-54 rounded-lg text-left text-body text-foreground outline-offset-2 focus-visible:focus-ring",
        selected && "focus-ring",
        onOpen !== undefined && "cursor-pointer",
        skipped && "opacity-55",
        className
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onOpen?.();
        }
      }}
      onKeyDown={open}
      {...props}
    >
      {stacked ? (
        <span
          aria-hidden="true"
          data-slot="flow-stack"
          className="absolute inset-0 -z-10 translate-x-1.5 translate-y-1.5 rounded-lg border border-input bg-background"
        />
      ) : null}
      <div
        ref={frameRef}
        data-slot="flow-frame"
        className={cn(
          "relative rounded-lg border bg-background transition-[border-color,box-shadow] duration-(--duration-color)",
          presentation.frame,
          skipped ? "" : "shadow-raised",
          onOpen !== undefined && status === "idle" && "hover:border-input-strong"
        )}
      >
        {main}
        {hasRows ? (
          <div data-slot="flow-rows" className="mt-2.5 border-t">
            {rows.map((row) => (
              <div
                key={row.id}
                data-slot="flow-row"
                data-exit={row.id}
                className={cn(
                  "relative flex h-7.5 items-center border-b px-3 font-medium last:border-b-0",
                  // Compact, a row is read from as far away as the title.
                  compact ? "text-title-lg leading-6" : "text-caption"
                )}
              >
                <span className="truncate">{row.label}</span>
                {row.handle}
              </div>
            ))}
          </div>
        ) : null}
        {showsFooter ? (
          <div
            data-slot="flow-footer"
            className={cn(
              "mt-2.5 flex items-start gap-1.5 rounded-b-lg border-t px-3 py-1.5 text-caption text-muted-foreground",
              status === "failed" && "bg-destructive-soft text-destructive-soft-foreground",
              compact && "invisible"
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex shrink-0 [&_svg]:size-3.5 [&_svg]:stroke-2",
                presentation.footerIcon
              )}
            >
              {presentation.icon}
            </span>
            <span className="min-w-0 flex-1 break-words">
              {footer ?? statusWord}
              {footer !== undefined && statusWord !== undefined ? (
                <span className="sr-only"> {statusWord}</span>
              ) : null}
            </span>
            {meta === undefined ? null : (
              <span className="shrink-0 pl-2 whitespace-nowrap tabular-nums">{meta}</span>
            )}
          </div>
        ) : hasRows ? null : (
          <div className="h-3" />
        )}
        {compact && !hasRows ? <CompactLine {...head} /> : null}
        {handles}
      </div>
      {presentation.badge === "" ? null : (
        <span
          aria-hidden="true"
          data-slot="flow-badge"
          className={cn(
            "absolute -top-2 -right-2 grid size-5 place-items-center rounded-full border-2 border-muted [&_svg]:size-3 [&_svg]:stroke-3",
            presentation.badge
          )}
        >
          {presentation.icon}
        </span>
      )}
    </div>
  );
}

/** Icon and title alone, over the part of the frame they stand for. */
function CompactLine(head: Omit<FlowHeadProps, "compact" | "end">) {
  return (
    <div
      data-slot="flow-compact"
      className="absolute inset-0 flex items-center overflow-hidden px-3.5"
    >
      <div className="min-w-0 flex-1">
        <FlowHead {...head} compact />
      </div>
    </div>
  );
}
