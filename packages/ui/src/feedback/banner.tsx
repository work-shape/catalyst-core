import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { IconButton } from "../actions/icon-button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

export type BannerTone = "info" | "success" | "warning" | "danger";
/**
 * `inline` is a box inside the content; `page` spans the page's width under its header; `line`
 * is one quiet sentence beside what it concerns, where only the icon carries the tone.
 */
export type BannerLayout = "inline" | "page" | "line";

// The soft recipe: the tone's tint as fill, its soft foreground as text, its line as border.
const bannerTones: Record<BannerTone, string> = {
  info: "border-info-border bg-info-soft text-info-soft-foreground",
  success: "border-success-border bg-success-soft text-success-soft-foreground",
  warning: "border-warning-border bg-warning-soft text-warning-soft-foreground",
  danger: "border-destructive-border bg-destructive-soft text-destructive-soft-foreground"
};

const bannerLayouts: Record<BannerLayout, string> = {
  inline: "gap-2.5 rounded-md border px-3 py-2 text-body",
  page: "gap-2.5 border-b px-(--layout-gutter) py-2 text-body",
  line: "gap-1.5 text-caption text-muted-foreground"
};

// A line has no fill to carry the tone, so its icon takes the tone's own colour.
const lineIconTones: Record<BannerTone, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive"
};

const toneIcons: Record<BannerTone, ReactNode> = {
  info: <Info aria-hidden="true" />,
  success: <CircleCheck aria-hidden="true" />,
  warning: <TriangleAlert aria-hidden="true" />,
  danger: <CircleAlert aria-hidden="true" />
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: BannerTone;
  layout?: BannerLayout;
  /** Takes the place of the tone's icon. `null` shows none. */
  icon?: ReactNode;
  title?: ReactNode;
  /** What answers the message: one small Button, or two where the second is the quieter. */
  action?: ReactNode;
  /** Shows a dismiss button. */
  onDismiss?(): void;
}

/**
 * A message that concerns the content under it: why it is read-only, what is missing, what
 * went wrong. A danger banner is announced at once, the others when the reader is idle.
 */
export function Banner({
  tone = "info",
  layout = "inline",
  icon,
  title,
  action,
  onDismiss,
  className,
  children,
  ...props
}: BannerProps) {
  const labels = useUiLabels("Banner");
  const shownIcon = icon === undefined ? toneIcons[tone] : icon;
  const line = layout === "line";
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-tone={tone}
      className={cn(
        "flex items-start",
        // A message with an action stacks where the two do not fit beside each other.
        action === undefined ? undefined : "flex-wrap sm:flex-nowrap",
        line ? undefined : bannerTones[tone],
        bannerLayouts[layout],
        className
      )}
      {...props}
    >
      {shownIcon === null ? null : (
        <span
          className={cn(
            "flex shrink-0 items-center",
            line ? cn("h-4 [&>svg]:size-3.5", lineIconTones[tone]) : "h-5 [&>svg]:size-4"
          )}
        >
          {shownIcon}
        </span>
      )}
      <div className="grid min-w-0 flex-1 gap-0.5">
        {title === undefined ? null : <p className="text-label">{title}</p>}
        {children === undefined ? null : <div>{children}</div>}
      </div>
      {action === undefined ? null : (
        <div
          className={cn(
            "flex shrink-0 basis-full items-center gap-1 sm:-my-1.5 sm:basis-auto",
            // On its own line the action starts where the text does, after the icon.
            shownIcon === null ? undefined : line ? "pl-5 sm:pl-0" : "pl-6.5 sm:pl-0"
          )}
        >
          {action}
        </div>
      )}
      {onDismiss ? (
        <IconButton
          size="sm"
          label={labels.dismiss}
          className="-my-1 -mr-1 text-current"
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}
