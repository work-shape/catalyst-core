import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { IconButton } from "../actions/icon-button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

export type BannerTone = "info" | "success" | "warning" | "danger";
/** `inline` is a box inside the content; `page` spans the page's width under its header. */
export type BannerLayout = "inline" | "page";

// The soft recipe: the tone's tint as fill, its soft foreground as text, its line as border.
const bannerTones: Record<BannerTone, string> = {
  info: "border-info-border bg-info-soft text-info-soft-foreground",
  success: "border-success-border bg-success-soft text-success-soft-foreground",
  warning: "border-warning-border bg-warning-soft text-warning-soft-foreground",
  danger: "border-destructive-border bg-destructive-soft text-destructive-soft-foreground"
};

const bannerLayouts: Record<BannerLayout, string> = {
  inline: "rounded-md border px-3 py-2",
  page: "border-b px-(--layout-gutter) py-2"
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
  /** One action that answers the message, usually a small Button. */
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
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      data-tone={tone}
      className={cn(
        "flex items-start gap-2.5 text-body",
        bannerTones[tone],
        bannerLayouts[layout],
        className
      )}
      {...props}
    >
      {shownIcon === null ? null : (
        <span className="flex h-5 shrink-0 items-center [&>svg]:size-4">{shownIcon}</span>
      )}
      <div className="grid min-w-0 flex-1 gap-0.5">
        {title === undefined ? null : <p className="text-label">{title}</p>}
        {children === undefined ? null : <div>{children}</div>}
      </div>
      {action === undefined ? null : (
        <div className="-my-1.5 flex shrink-0 items-center">{action}</div>
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
