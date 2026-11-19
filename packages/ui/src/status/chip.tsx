import { Building2, Lock, UserRound, X } from "lucide-react";
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type MouseEventHandler,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";
import { Avatar, type AvatarAccent } from "./avatar";

export type ChipSize = "sm" | "md";

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

  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center rounded-full border text-caption whitespace-nowrap text-foreground",
        chipSizes[size],
        pressed && "border-primary-border bg-primary-soft text-primary-soft-foreground",
        className
      )}
    >
      {href !== undefined ? (
        <a href={href} className={cn(bodyClassName, interactiveClassName)} onClick={onClick}>
          {body}
        </a>
      ) : onClick ? (
        <button
          type="button"
          className={cn(bodyClassName, interactiveClassName)}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {body}
        </button>
      ) : (
        <span className={bodyClassName}>{body}</span>
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
