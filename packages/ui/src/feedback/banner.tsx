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
  inline: "rounded-md border px-3 py-2 text-body",
  page: "border-b px-(--layout-gutter) py-2 text-body",
  line: "text-caption text-muted-foreground"
};

// One gap between the icon, the text, the actions and the dismiss, on every level of the row.
const bannerGaps: Record<BannerLayout, string> = {
  inline: "gap-2.5",
  page: "gap-2.5",
  line: "gap-1.5"
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
  const gap = bannerGaps[layout];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-tone={tone}
      className={cn(
        "flex items-start",
        line ? undefined : bannerTones[tone],
        bannerLayouts[layout],
        gap,
        className
      )}
      {...props}
    >
      {/*
       * The message and its actions. An action is taller than a line of text, so it is centred
       * on the whole message: one line sits on the action's middle, a title with its text has
       * the action beside both, and the action never reaches into the banner's padding. Where
       * the two do not fit beside each other, the actions take a line of their own.
       */}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center",
          action === undefined ? undefined : "flex-wrap sm:flex-nowrap",
          gap
        )}
      >
        {/* The icon stays on the first line of the message, beside the title it marks. */}
        <div className={cn("flex min-w-0 flex-1 items-start", gap)}>
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
        </div>
        {action === undefined ? null : (
          <div
            className={cn(
              // Several actions wrap onto further lines where one line is too narrow for them,
              // as on a phone, instead of running past the edge.
              "flex min-w-0 shrink-0 basis-full flex-wrap items-center gap-1 sm:basis-auto",
              // On its own line the action starts where the text does, after the icon.
              shownIcon === null ? undefined : line ? "pl-5 sm:pl-0" : "pl-6.5 sm:pl-0"
            )}
          >
            {action}
          </div>
        )}
      </div>
      {onDismiss ? (
        <IconButton
          size="sm"
          label={labels.dismiss}
          // Beside the actions it takes their middle; above actions on a line of their own it
          // stays on the first line, at the top end of the banner.
          className="-my-1 -mr-1 text-current sm:self-center"
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}
