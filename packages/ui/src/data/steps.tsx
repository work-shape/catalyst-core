import { Collapsible } from "radix-ui";
import { Check, ChevronRight, CircleAlert, Clock, Minus, X } from "lucide-react";
import { useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { Spinner } from "../feedback/spinner";
import type { UiLabels } from "../labels";
import { useUiLabels } from "../ui-root";

/** How far a step of something that runs has come. `none` is a step that is only described. */
export type StepState =
  "none" | "queued" | "running" | "waiting" | "done" | "failed" | "cancelled" | "limit_reached";

/** Colours the marker and the line below it. */
export type StepTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StepsProps extends Omit<HTMLAttributes<HTMLOListElement>, "aria-label"> {
  /** Names the list for someone who does not see it. */
  label: string;
  /**
   * The list stands inside a `Step`, as the steps repeated for each entry of that step. It is
   * set in by a bar, and drawn in a box where the outer list is wide enough for one.
   */
  nested?: boolean;
}

/** Steps in the order they happen, joined by a line. One list nests inside a step of another. */
export function Steps({ className, label, nested = false, ...props }: StepsProps) {
  return (
    <ol
      // A list without markers of its own is announced as a list only when it says so.
      role="list"
      aria-label={label}
      data-nested={nested ? "" : undefined}
      className={cn(
        "m-0 grid min-w-0 list-none p-0",
        nested ? "border-l-2 pl-3 @lg:rounded-md @lg:border @lg:p-3" : "@container",
        className
      )}
      {...props}
    />
  );
}

interface StatePresentation {
  tone: StepTone;
  /** The step was not reached: its text recedes. */
  muted: boolean;
  marker: ReactNode;
  label?: keyof UiLabels;
}

const statePresentations: Record<StepState, StatePresentation> = {
  none: { tone: "neutral", muted: false, marker: null },
  queued: { tone: "neutral", muted: true, marker: null, label: "stateQueued" },
  running: { tone: "info", muted: false, marker: <Spinner size="sm" />, label: "stateRunning" },
  waiting: {
    tone: "neutral",
    muted: false,
    marker: <Clock aria-hidden="true" />,
    label: "stateWaiting"
  },
  done: { tone: "success", muted: false, marker: <Check aria-hidden="true" />, label: "stateDone" },
  failed: { tone: "danger", muted: false, marker: <X aria-hidden="true" />, label: "stateFailed" },
  cancelled: {
    tone: "neutral",
    muted: false,
    marker: <Minus aria-hidden="true" />,
    label: "stateCancelled"
  },
  limit_reached: {
    tone: "danger",
    muted: false,
    marker: <CircleAlert aria-hidden="true" />,
    label: "stateLimitReached"
  }
};

// The soft recipe of a state, as a badge has it. A neutral marker is an outline.
const markerTones: Record<StepTone, string> = {
  neutral: "border-input-strong text-muted-foreground",
  info: "border-info-border bg-info-soft text-info-soft-foreground",
  success: "border-success-border bg-success-soft text-success-soft-foreground",
  warning: "border-warning-border bg-warning-soft text-warning-soft-foreground",
  danger: "border-destructive-border bg-destructive-soft text-destructive-soft-foreground"
};

const lineTones: Record<StepTone, string> = {
  neutral: "bg-border",
  info: "bg-info-border",
  success: "bg-success-border",
  warning: "bg-warning-border",
  danger: "bg-destructive-border"
};

export interface StepProps extends Omit<HTMLAttributes<HTMLLIElement>, "title"> {
  /** Sets the marker, the tone and whether the text recedes. Each of the three can be set apart. */
  state?: StepState;
  /** A number, a letter or an icon in the marker, in place of the state's own. */
  marker?: ReactNode;
  tone?: StepTone;
  /** The step's text recedes, as for a step that was not reached. */
  muted?: boolean;
  /** A small line above the title: the kind of step, as text or with a link in it. */
  eyebrow?: ReactNode;
  title?: ReactNode;
  /** One sentence on what the step does. */
  description?: ReactNode;
  /** A fixed, quieter line under the description. */
  note?: ReactNode;
  /** At the row's end: when it happened or how long it took. */
  meta?: ReactNode;
  /** A `Badge` before `meta`, such as what changed about the step. */
  badge?: ReactNode;
  /** The step unfolds: `children` show below it while it is expanded. Otherwise they always show. */
  expandable?: boolean;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
}

/**
 * One step of a `Steps` list: a marker on the line, then what the step is called and does. Its
 * `children` are the step's body, such as what it returned, or a nested `Steps`.
 */
export function Step({
  className,
  state = "none",
  marker,
  tone,
  muted,
  eyebrow,
  title,
  description,
  note,
  meta,
  badge,
  expandable = false,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  children,
  ...props
}: StepProps) {
  const presentation = statePresentations[state];
  const shownTone = tone ?? presentation.tone;
  const recedes = muted ?? presentation.muted;
  const [ownExpanded, setOwnExpanded] = useState(defaultExpanded);
  const open = expanded ?? ownExpanded;
  const strong = recedes ? "text-muted-foreground" : "text-foreground";

  // The first line stands beside the marker and is as high as it; `badge` and `meta` end it.
  const eyebrowLine =
    eyebrow === undefined ? null : (
      <div
        data-slot="step-eyebrow"
        className="min-w-0 py-1 text-caption font-medium break-words text-muted-foreground"
      >
        {eyebrow}
      </div>
    );
  const titleText =
    title === undefined ? null : (
      <span data-slot="step-title" className={cn("min-w-0 text-label break-words", strong)}>
        {title}
      </span>
    );
  const heading = expandable ? (
    <Collapsible.Trigger
      className={cn(
        "group/step-trigger relative flex max-w-full min-w-0 items-start gap-1 rounded-md text-left focus-visible:focus-ring",
        (eyebrowLine === null || titleText === null) && "py-0.5"
      )}
    >
      {titleText ?? <ExpandName expanded={open} />}
      <ChevronRight
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover/step-trigger:text-foreground group-data-[state=open]/step-trigger:rotate-90"
      />
    </Collapsible.Trigger>
  ) : titleText === null ? null : (
    <div className={cn("flex min-w-0", eyebrowLine === null && "py-0.5")}>{titleText}</div>
  );

  // Without a title the control that unfolds the step ends the eyebrow's line.
  const untitledTrigger = expandable && titleText === null && eyebrowLine !== null;

  const step = (
    <li
      data-step-state={state}
      className={cn(
        "flex min-w-0 gap-3",
        // The last step of its own list ends the line; a nested list has a last step of its own.
        "[&:last-child>[data-slot=step-rail]>[data-slot=step-line]]:hidden [&:not(:last-child)>[data-slot=step-content]]:pb-5",
        className
      )}
      {...props}
    >
      <div data-slot="step-rail" className="flex shrink-0 flex-col items-center">
        <span
          data-slot="step-marker"
          data-tone={shownTone}
          className={cn(
            "relative flex size-6 shrink-0 items-center justify-center rounded-full border text-caption font-medium [&>svg]:size-3.5",
            markerTones[shownTone]
          )}
        >
          {marker ?? presentation.marker}
          {presentation.label === undefined ? null : <StateName label={presentation.label} />}
        </span>
        <span
          aria-hidden="true"
          data-slot="step-line"
          className={cn("mt-1 w-px flex-1", lineTones[shownTone])}
        />
      </div>
      <div data-slot="step-content" className="grid min-w-0 flex-1 content-start">
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-1">
            {eyebrowLine ?? heading}
            {untitledTrigger ? heading : null}
          </div>
          {badge === undefined ? null : (
            <span className="flex min-h-6 shrink-0 items-center">{badge}</span>
          )}
          {meta === undefined ? null : (
            <span
              data-slot="step-meta"
              className="shrink-0 py-1 text-caption whitespace-nowrap text-muted-foreground tabular-nums"
            >
              {meta}
            </span>
          )}
        </div>
        {eyebrowLine === null || untitledTrigger ? null : heading}
        {description === undefined ? null : (
          <p data-slot="step-description" className={cn("text-body break-words", strong)}>
            {description}
          </p>
        )}
        {note === undefined ? null : (
          <p
            data-slot="step-note"
            className="mt-0.5 text-caption break-words text-muted-foreground"
          >
            {note}
          </p>
        )}
        {expandable ? (
          <Collapsible.Content data-slot="step-body" className="mt-2 min-w-0 text-body">
            {children}
          </Collapsible.Content>
        ) : children === undefined || children === null ? null : (
          <div data-slot="step-body" className="mt-2 min-w-0 text-body">
            {children}
          </div>
        )}
      </div>
    </li>
  );
  if (!expandable) {
    return step;
  }
  return (
    <Collapsible.Root
      asChild
      open={open}
      onOpenChange={(next) => {
        setOwnExpanded(next);
        onExpandedChange?.(next);
      }}
    >
      {step}
    </Collapsible.Root>
  );
}

/** The state in words, for a marker that shows it as an icon or a colour alone. */
function StateName({ label }: { label: keyof UiLabels }) {
  const labels = useUiLabels("Step");
  return <span className="sr-only">{labels[label]}</span>;
}

/** The name of the control that unfolds a step without a title. */
function ExpandName({ expanded }: { expanded: boolean }) {
  const labels = useUiLabels("Step");
  return <span className="sr-only">{expanded ? labels.collapse : labels.expand}</span>;
}
