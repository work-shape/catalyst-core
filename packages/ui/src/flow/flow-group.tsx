import { ChevronDown } from "lucide-react";
import type { HTMLAttributes, KeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";
import { FlowHead, flowStatusPresentations } from "./flow-node";
import { flowChangeFrames } from "./flow-change";
import type { FlowChange, FlowStatus } from "./flow-types";

// A group's line is dashed, so a status colours it at full strength where a node's is soft.
const groupFrames: Record<FlowStatus, string> = {
  idle: "border-input-strong",
  running: "border-info",
  waiting: "border-warning",
  done: "border-success",
  doneWithFailures: "border-warning",
  failed: "border-destructive",
  skipped: "border-input-strong"
};

export interface FlowGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  accent?: boolean;
  /** The type of the group in plain words. */
  eyebrow?: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  change?: FlowChange;
  oldSummary?: ReactNode;
  /** Under the summary: how far the group is, as a `Progress` with its line of counts. */
  progress?: ReactNode;
  /** A control at the end of the head's content. */
  action?: ReactNode;
  status?: FlowStatus;
  selected?: boolean;
  compact?: boolean;
  /** Folded to its head. */
  collapsed?: boolean;
  /** With it the head shows the control that folds and unfolds the group. */
  onCollapsedChange?(collapsed: boolean): void;
  /** The accessible name: the type, the title and the status in words. */
  label?: string;
  /** Called by a press on the head, Enter and Space. With it the group takes the focus. */
  onOpen?(): void;
  handles?: ReactNode;
  headRef?: Ref<HTMLDivElement>;
  /** The nodes the group holds. A canvas leaves this empty and lays its nodes over the body. */
  children?: ReactNode;
}

/**
 * A dashed container with a head and a body for the nodes it holds. The head takes what a node
 * takes, and how far the group is. It folds to its head.
 */
export function FlowGroup({
  icon,
  accent,
  eyebrow,
  title,
  summary,
  change,
  oldSummary,
  progress,
  action,
  status = "idle",
  selected = false,
  compact = false,
  collapsed = false,
  onCollapsedChange,
  label,
  onOpen,
  handles,
  headRef,
  children,
  className,
  onKeyDown,
  ...props
}: FlowGroupProps) {
  const labels = useUiLabels("FlowGroup");
  const presentation = flowStatusPresentations[status];
  const statusWord = presentation.label === undefined ? undefined : labels[presentation.label];
  const head = { icon, accent, eyebrow, title, change };
  const fold =
    onCollapsedChange === undefined ? null : (
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? labels.expand : labels.collapse}
        data-slot="flow-fold"
        className="-m-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:focus-ring"
        onClick={(event) => {
          event.stopPropagation();
          onCollapsedChange(!collapsed);
        }}
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 transition-transform duration-(--duration-color) motion-reduce:transition-none",
            collapsed && "-rotate-90"
          )}
        />
      </button>
    );

  const open = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
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
      data-slot="flow-group"
      data-status={status}
      data-change={change}
      data-selected={selected ? "" : undefined}
      data-collapsed={collapsed ? "" : undefined}
      className={cn(
        "relative flex w-61 flex-col rounded-xl border-[1.5px] border-dashed bg-background/55 text-left text-body text-foreground outline-offset-2 focus-visible:focus-ring",
        groupFrames[status],
        change !== undefined && flowChangeFrames[change],
        selected && "focus-ring",
        (status === "skipped" || change === "removed") && "opacity-55",
        change === "removed" &&
          "[&_[data-slot=flow-title]]:line-through [&_[data-slot=flow-summary]]:line-through",
        className
      )}
      onKeyDown={open}
      {...props}
    >
      <div
        ref={headRef}
        data-slot="flow-group-head"
        className={cn(
          "relative shrink-0 rounded-t-xl bg-background",
          collapsed ? "rounded-b-xl" : "border-b",
          onOpen !== undefined && "cursor-pointer"
        )}
        onClick={onOpen}
      >
        <div className={cn("grid min-w-0 px-3 pt-3 pb-3", compact && "invisible")}>
          <FlowHead {...head} end={fold} />
          {change === "changed" && oldSummary !== undefined ? (
            <del data-slot="flow-old-summary" className="pt-1.5 text-caption text-muted-foreground">
              {oldSummary}
            </del>
          ) : null}
          {summary === undefined ? null : (
            <p data-slot="flow-summary" className="pt-1.5 text-caption text-muted-foreground">
              {summary}
            </p>
          )}
          {progress === undefined ? null : (
            <div data-slot="flow-progress" className="grid min-w-0 gap-1.5 pt-2.5">
              {progress}
            </div>
          )}
          {action === undefined ? null : (
            <div
              data-slot="flow-action"
              className="mt-2 flex"
              // A press on the control is not a press on the head.
              onClick={(event) => event.stopPropagation()}
            >
              {action}
            </div>
          )}
          {statusWord === undefined ? null : <span className="sr-only">{statusWord}</span>}
        </div>
        {compact ? (
          <div
            data-slot="flow-compact"
            className="absolute inset-0 flex items-center overflow-hidden px-3.5"
          >
            <div className="min-w-0 flex-1">
              <FlowHead {...head} compact />
            </div>
          </div>
        ) : null}
      </div>
      {collapsed ? null : (
        <div data-slot="flow-group-body" className="grid min-h-0 flex-1 gap-5.5 p-3.5">
          {children}
        </div>
      )}
      {handles}
      {collapsed && presentation.badge !== "" ? (
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
      ) : null}
    </div>
  );
}
