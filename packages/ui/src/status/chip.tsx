import { Building2, Lock, X } from "lucide-react";
import { useId, type MouseEventHandler, type ReactNode } from "react";
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
  size?: ChipSize;
  /** Says that the object cannot be changed here. It shows a lock and is read out. */
  lockLabel?: string;
  /** Shows a remove button after the label. */
  onRemove?(): void;
  /** Makes the chip a link to its object. */
  href?: string;
  /** Makes the chip a button, or handles the click on its link. */
  onClick?: MouseEventHandler<HTMLElement>;
  className?: string;
}

/** A small pill that names an object: a scope, a role, a group, a requester. */
export function Chip({
  children,
  leading,
  size = "md",
  lockLabel,
  onRemove,
  href,
  onClick,
  className
}: ChipProps) {
  const labels = useUiLabels("Chip");
  const labelId = useId();
  const bodyClassName = cn(
    "inline-flex h-full min-w-0 items-center gap-1 rounded-full pl-2 [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:stroke-2",
    onRemove ? "pr-1" : "pr-2"
  );
  const interactiveClassName = "transition-colors hover:bg-state-hover focus-visible:focus-ring";
  const body = (
    <>
      {leading}
      <span id={labelId} className="truncate">
        {children}
      </span>
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
        className
      )}
    >
      {href !== undefined ? (
        <a href={href} className={cn(bodyClassName, interactiveClassName)} onClick={onClick}>
          {body}
        </a>
      ) : onClick ? (
        <button type="button" className={cn(bodyClassName, interactiveClassName)} onClick={onClick}>
          {body}
        </button>
      ) : (
        <span className={bodyClassName}>{body}</span>
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={labels.remove}
          aria-describedby={labelId}
          className={cn(
            "mr-0.5 inline-flex aspect-square h-[calc(100%-0.25rem)] shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground [&_svg]:size-3 [&_svg]:stroke-2",
            interactiveClassName
          )}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

export interface ScopeChipProps {
  /** Whether the object belongs to the whole instance or to one workspace. */
  scope: "instance" | "workspace";
  /** The instance's or the workspace's name. */
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

/** The chip that says where an object lives: on the instance or in a workspace. */
export function ScopeChip({ scope, name, emoji, accent, readOnlyLabel, ...props }: ScopeChipProps) {
  return (
    <Chip
      leading={
        scope === "instance" ? (
          <Building2 aria-hidden="true" className="text-muted-foreground" />
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
