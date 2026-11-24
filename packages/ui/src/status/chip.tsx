import { Building2, Lock, UserRound, X } from "lucide-react";
import {
  Children,
  forwardRef,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEventHandler,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { Popover, PopoverContent, PopoverTrigger } from "../overlays/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";
import { useUiLabels } from "../ui-root";
import { Avatar, type AvatarAccent } from "./avatar";

export type ChipSize = "sm" | "md";
/** `quiet` is a label that stands back: a soft fill without a border, in muted ink. */
export type ChipTone = "default" | "quiet";

// A leading avatar fills the pill's height less a hair, so the chip sets its size.
const chipSizes: Record<ChipSize, string> = {
  sm: "h-5 **:data-kind:-ml-1.5 **:data-kind:size-4",
  md: "h-6 **:data-kind:-ml-1.5 **:data-kind:size-5"
};

export interface ChipProps {
  children: ReactNode;
  /** An avatar or an icon before the label. */
  leading?: ReactNode;
  /**
   * A short muted text after the label, such as the pages of a document. It stays whole while a
   * long label shortens with an ellipsis, and is read after the label, after a comma.
   */
  detail?: ReactNode;
  /**
   * An action of its own after the label, inside the pill: a `ChipAction`, alone or as the
   * trigger of a menu or popover on the object.
   */
  trailing?: ReactNode;
  size?: ChipSize;
  /**
   * `quiet` for a label beside something louder, such as what an agent knows next to the
   * requests a person can begin with: it reads as a fact, not as something to press.
   */
  tone?: ChipTone;
  /**
   * One or two sentences about the object, shown as a tooltip on hover and on keyboard focus.
   * A chip that is neither a link nor a button becomes a stop of the tab order for it and
   * keeps the look of a label.
   */
  description?: ReactNode;
  /**
   * The chip's name for assistive technology where the label alone does not say what the
   * object is, such as "Knowledge: Handbook" for a chip that shows a book and "Handbook".
   */
  accessibleLabel?: string;
  /** Says that the object cannot be changed here. It shows a lock and is read out. */
  lockLabel?: string;
  /** Shows a remove button after the label. */
  onRemove?(): void;
  /** Makes the chip a link to its object. */
  href?: string;
  /** Makes the chip a button, or handles the click on its link. */
  onClick?: MouseEventHandler<HTMLElement>;
  /**
   * Makes a button chip a filter that is on or off: it says so to assistive technology and
   * takes the selected fill while on.
   */
  pressed?: boolean;
  className?: string;
}

const interactiveClassName = "transition-colors hover:bg-state-hover focus-visible:focus-ring";

export interface ChipActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** What the action does, read out in place of its icon, such as "Details of report.pdf". */
  label: string;
  /** The icon of the action. */
  children: ReactNode;
}

/**
 * A round icon button at the trailing edge of a chip, given to its `trailing`: an action on
 * the object of its own beside the chip's click, such as the menu of its details. It forwards
 * its ref and props, so it can be the trigger of a menu or popover.
 */
export const ChipAction = forwardRef<HTMLButtonElement, ChipActionProps>(function ChipAction(
  { label, children, className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        "mr-0.5 inline-flex aspect-square h-[calc(100%-0.25rem)] shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground data-[state=open]:bg-state-hover data-[state=open]:text-foreground [&_svg]:size-3 [&_svg]:stroke-2",
        interactiveClassName,
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
});

/** A small pill that names an object: a scope, a role, a group, a requester. */
export function Chip({
  children,
  leading,
  detail,
  trailing,
  size = "md",
  tone = "default",
  description,
  accessibleLabel,
  lockLabel,
  onRemove,
  href,
  onClick,
  pressed,
  className
}: ChipProps) {
  const labels = useUiLabels("Chip");
  const labelId = useId();
  const bodyClassName = cn(
    "inline-flex h-full min-w-0 items-center gap-1 rounded-full pl-2 [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:stroke-2",
    onRemove || trailing !== undefined ? "pr-1" : "pr-2"
  );
  const body = (
    <>
      {leading}
      <span id={labelId} className="truncate">
        {children}
      </span>
      {detail === undefined ? null : (
        <span className="shrink-0 text-muted-foreground">
          <span className="sr-only">, </span>
          {detail}
        </span>
      )}
      {lockLabel === undefined ? null : (
        <>
          <Lock aria-hidden="true" className="text-muted-foreground" />
          <span className="sr-only">{lockLabel}</span>
        </>
      )}
    </>
  );

  const described = description !== undefined && description !== null && description !== "";
  const element =
    href !== undefined ? (
      <a
        href={href}
        aria-label={accessibleLabel}
        className={cn(bodyClassName, interactiveClassName)}
        onClick={onClick}
      >
        {body}
      </a>
    ) : onClick ? (
      <button
        type="button"
        aria-label={accessibleLabel}
        className={cn(bodyClassName, interactiveClassName)}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {body}
      </button>
    ) : described ? (
      // A label with more to say: focus opens its description, and nothing else happens.
      <button
        type="button"
        aria-label={accessibleLabel}
        className={cn(bodyClassName, "cursor-default focus-visible:focus-ring")}
      >
        {body}
      </button>
    ) : (
      <span className={bodyClassName}>
        {accessibleLabel === undefined ? (
          body
        ) : (
          <>
            <span className="sr-only">{accessibleLabel}</span>
            <span aria-hidden="true" className="contents">
              {body}
            </span>
          </>
        )}
      </span>
    );

  return (
    <span
      data-tone={tone === "quiet" ? "quiet" : undefined}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center rounded-full border text-caption whitespace-nowrap",
        tone === "quiet"
          ? "border-transparent bg-secondary text-muted-foreground"
          : "text-foreground",
        chipSizes[size],
        pressed && "border-primary-border bg-primary-soft text-primary-soft-foreground",
        className
      )}
    >
      {described ? (
        <Tooltip>
          <TooltipTrigger asChild>{element}</TooltipTrigger>
          <TooltipContent className="whitespace-normal">{description}</TooltipContent>
        </Tooltip>
      ) : (
        element
      )}
      {trailing}
      {onRemove ? (
        <ChipAction label={labels.remove} aria-describedby={labelId} onClick={onRemove}>
          <X aria-hidden="true" />
        </ChipAction>
      ) : null}
    </span>
  );
}

export interface ChipListProps {
  /** What the chips are, for assistive technology: "Knowledge". */
  label: string;
  children: ReactNode;
  /** What the "+3" chip opens, read out in place of the number: "Show 3 more". */
  moreLabel?(hidden: number): string;
  size?: ChipSize;
  tone?: ChipTone;
  className?: string;
}

/** The room between two chips of a list, in pixels: `gap-1.5`. */
const CHIP_LIST_GAP = 6;

/**
 * How many chips of the given widths stand on one line of the room there is, when those that
 * do not are told by one chip of the width `more` at the end. All of them where they fit
 * without it, and never fewer than one: the first then shortens with an ellipsis.
 */
function chipsThatFit(widths: readonly number[], room: number, more: number): number {
  const gaps = (count: number) => Math.max(count - 1, 0) * CHIP_LIST_GAP;
  const sum = (count: number) =>
    widths.slice(0, count).reduce((total, width) => total + Math.ceil(width), 0);
  // A list that is not laid out, such as one in a hidden panel, has no room to measure.
  if (room <= 0 || sum(widths.length) + gaps(widths.length) <= room) {
    return widths.length;
  }
  for (let count = widths.length - 1; count > 1; count -= 1) {
    if (sum(count) + gaps(count + 1) + Math.ceil(more) <= room) {
      return count;
    }
  }
  return Math.min(widths.length, 1);
}

const moreChipClassName = (size: ChipSize, tone: ChipTone) =>
  cn(
    "inline-flex shrink-0 items-center rounded-full border px-2 text-caption whitespace-nowrap data-[state=open]:bg-state-hover",
    tone === "quiet" ? "border-transparent bg-secondary text-muted-foreground" : "text-foreground",
    chipSizes[size],
    interactiveClassName
  );

/**
 * Chips side by side on one line that never wraps. The list measures its room and shows as
 * many chips as fit; the rest stand behind one chip with their number, "+3", which opens a
 * small list of them on a click and on keyboard focus. It measures again when its width or
 * its chips change, so it holds at any width down to a phone's. A single chip wider than the
 * room shortens with an ellipsis.
 */
export function ChipList({
  label,
  children,
  moreLabel,
  size = "md",
  tone = "default",
  className
}: ChipListProps) {
  const chips = Children.toArray(children);
  const rowRef = useRef<HTMLUListElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const restRef = useRef<HTMLUListElement>(null);
  // The server and the first frame show every chip; the measure follows before the paint.
  const [mounted, setMounted] = useState(false);
  const [fit, setFit] = useState(chips.length);
  const [open, setOpen] = useState(false);
  // Focus that returns to "+3" as its list closes does not open it again.
  const returningFocus = useRef(false);
  useLayoutEffect(() => setMounted(true), []);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) {
      return;
    }
    const fitChips = () => {
      const widths = Array.from(measure.children, (child) => child.getBoundingClientRect().width);
      const more = widths.pop() ?? 0;
      setFit(chipsThatFit(widths, row.clientWidth, more));
    };
    fitChips();
    const observer = new ResizeObserver(fitChips);
    observer.observe(row);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [mounted, chips.length]);

  if (chips.length === 0) {
    return null;
  }
  const shown = Math.min(fit, chips.length);
  const hidden = chips.length - shown;
  return (
    <div className="w-full min-w-0">
      <ul
        ref={rowRef}
        aria-label={label}
        className={cn(
          "flex w-full min-w-0 flex-nowrap items-center gap-1.5",
          !mounted && "overflow-hidden",
          className
        )}
      >
        {chips.slice(0, shown).map((chip, index) => (
          <li
            key={index}
            className={cn("flex", hidden > 0 && shown === 1 ? "min-w-0" : "shrink-0")}
          >
            {chip}
          </li>
        ))}
        {hidden === 0 ? null : (
          <li className="flex shrink-0">
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger
                aria-label={moreLabel?.(hidden)}
                className={moreChipClassName(size, tone)}
                onFocus={(event) => {
                  if (returningFocus.current) {
                    returningFocus.current = false;
                  } else if (event.currentTarget.matches(":focus-visible")) {
                    setOpen(true);
                  }
                }}
              >
                +{hidden}
              </PopoverTrigger>
              <PopoverContent
                size="fit"
                align="end"
                className="max-w-72 p-2"
                // Focus goes to the list, not to its first chip, whose description would open
                // over the line at once.
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  restRef.current?.focus();
                }}
                onCloseAutoFocus={() => {
                  returningFocus.current = true;
                }}
              >
                <ul
                  ref={restRef}
                  tabIndex={-1}
                  aria-label={moreLabel?.(hidden)}
                  className="grid justify-items-start gap-1.5 outline-none"
                >
                  {chips.slice(shown).map((chip, index) => (
                    <li key={index} className="flex max-w-full min-w-0">
                      {chip}
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          </li>
        )}
      </ul>
      {mounted ? (
        // Every chip and the widest "+N" at their own width, out of sight: what the fit reads.
        <div
          aria-hidden="true"
          inert
          className="pointer-events-none invisible relative h-0 overflow-hidden"
        >
          <div ref={measureRef} className="flex w-max gap-1.5">
            {chips.map((chip, index) => (
              <span key={index} className="flex shrink-0">
                {chip}
              </span>
            ))}
            <span className={moreChipClassName(size, tone)}>+{chips.length}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface ScopeChipProps {
  /**
   * Where the object sits: on the whole instance, in one workspace, or in the reader's own
   * Personal Workspace, which nobody else sees.
   */
  scope: "instance" | "workspace" | "personal";
  /** The instance's or the workspace's name, or the reader's word for their own place. */
  name: string;
  /** The workspace's emoji. */
  emoji?: string | null;
  /** The workspace's colour pair. */
  accent?: AvatarAccent;
  /** Says that the object is read-only in this scope. It shows a lock and is read out. */
  readOnlyLabel?: string;
  size?: ChipSize;
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  className?: string;
}

/** The chip that says where an object lives: on the instance, in a workspace, or the reader's own. */
export function ScopeChip({ scope, name, emoji, accent, readOnlyLabel, ...props }: ScopeChipProps) {
  return (
    <Chip
      leading={
        scope === "instance" ? (
          <Building2 aria-hidden="true" className="text-muted-foreground" />
        ) : scope === "personal" ? (
          <UserRound aria-hidden="true" className="text-muted-foreground" />
        ) : (
          // Inside the pill a radius of 8 would read as a person's circle, so it is 4 here.
          <Avatar
            kind="workspace"
            size="xs"
            name={name}
            emoji={emoji}
            accent={accent}
            className="rounded-sm"
          />
        )
      }
      lockLabel={readOnlyLabel}
      {...props}
    >
      {name}
    </Chip>
  );
}
