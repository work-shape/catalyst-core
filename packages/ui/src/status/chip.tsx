import { Building2, Lock, UserRound, X } from "lucide-react";
import {
  Children,
  forwardRef,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type MouseEventHandler,
  type ReactNode
} from "react";
import { cn } from "../cn";
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
  /** How many chips show before the rest folds into one "+3" chip. Without it all show. */
  max?: number;
  /** What the "+3" chip does, read out in place of the number: "Show 3 more". */
  moreLabel?(hidden: number): string;
  size?: ChipSize;
  tone?: ChipTone;
  className?: string;
}

/**
 * Chips side by side as one list that wraps onto more lines. With `max`, a longer list shows
 * that many and one chip with the number of the rest, which shows them all when chosen; a
 * list one over the limit shows whole, as "+1" would take the room of the chip it hides.
 */
export function ChipList({
  label,
  children,
  max,
  moreLabel,
  size = "md",
  tone = "default",
  className
}: ChipListProps) {
  const chips = Children.toArray(children);
  const [unfolded, setUnfolded] = useState(false);
  const folds = max !== undefined && chips.length > max + 1 && !unfolded;
  const hidden = folds ? chips.length - max : 0;
  if (chips.length === 0) {
    return null;
  }
  return (
    <ul aria-label={label} className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      {(folds ? chips.slice(0, max) : chips).map((chip, index) => (
        <li key={index} className="flex min-w-0 max-w-full">
          {chip}
        </li>
      ))}
      {folds ? (
        <li className="flex">
          <Chip
            size={size}
            tone={tone}
            accessibleLabel={moreLabel?.(hidden)}
            onClick={() => setUnfolded(true)}
          >
            +{hidden}
          </Chip>
        </li>
      ) : null}
    </ul>
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
