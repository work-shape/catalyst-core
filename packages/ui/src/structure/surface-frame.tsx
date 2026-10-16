import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";

/** The slots of a surface's header, in the one order every surface has. */
export interface SurfaceHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** What stands before the name, such as the button that brings the conversation back. */
  leading?: ReactNode;
  /** An icon of what the surface shows, such as a file's type. It stands before the name. */
  icon?: ReactNode;
  /** The surface's name, on one line. */
  title: ReactNode;
  /** One muted line under the name. */
  subtitle?: ReactNode;
  /** The actions of the surface's own kind, such as a download. */
  actions?: ReactNode;
  /** The button that makes the surface fill the window, or brings it back. */
  fullscreen?: ReactNode;
  /** The button that closes the surface, always last. */
  close?: ReactNode;
}

/**
 * The header of a working surface, as high as every other header, so one line runs across the
 * window. A panel that frames its content itself, such as the chat dock, takes it alone.
 */
export function SurfaceHeader({
  className,
  leading,
  icon,
  title,
  subtitle,
  actions,
  fullscreen,
  close,
  ...props
}: SurfaceHeaderProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [clipped, setClipped] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    const measure = () => {
      const cut = element.scrollWidth > element.clientWidth;
      setClipped(cut);
      if (!cut) setTooltipOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [title]);

  return (
    <header
      className={cn(
        "flex h-(--layout-header) shrink-0 items-center gap-2 border-b px-3 sm:gap-3 sm:px-4",
        className
      )}
      {...props}
    >
      {leading === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{leading}</div>
      )}
      {icon === undefined ? null : <div className="flex shrink-0 items-center">{icon}</div>}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <Tooltip
          open={clipped && tooltipOpen}
          onOpenChange={(open) => setTooltipOpen(clipped && open)}
        >
          <TooltipTrigger asChild>
            <h2
              ref={titleRef}
              tabIndex={clipped ? 0 : undefined}
              className="truncate text-heading focus-visible:focus-ring"
            >
              {title}
            </h2>
          </TooltipTrigger>
          {clipped ? <TooltipContent>{title}</TooltipContent> : null}
        </Tooltip>
        {subtitle === undefined ? null : (
          <p className="truncate text-caption text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
      {fullscreen}
      {close}
    </header>
  );
}

export interface SurfaceFrameProps
  extends
    Omit<HTMLAttributes<HTMLDivElement>, "title">,
    Pick<
      SurfaceHeaderProps,
      "leading" | "icon" | "title" | "subtitle" | "actions" | "fullscreen" | "close"
    > {
  /**
   * The content reaches the edges of the frame and lays out its own height, such as a preview
   * that fills the surface. Without it the content has the frame's inset and scrolls.
   */
  flush?: boolean;
  /** What the surface shows. It scrolls under the header. */
  children?: ReactNode;
}

/**
 * The frame of a working surface: its header and the content below it.
 */
export function SurfaceFrame({
  className,
  leading,
  icon,
  title,
  subtitle,
  actions,
  fullscreen,
  close,
  flush = false,
  children,
  ...props
}: SurfaceFrameProps) {
  return (
    <div
      className={cn("flex h-full min-h-0 min-w-0 flex-col bg-card text-card-foreground", className)}
      {...props}
    >
      <SurfaceHeader
        leading={leading}
        icon={icon}
        title={title}
        subtitle={subtitle}
        actions={actions}
        fullscreen={fullscreen}
        close={close}
      />
      <div
        data-flush={flush ? "" : undefined}
        className={cn(
          "min-h-0 flex-1 bg-background",
          flush ? "overflow-hidden" : "overflow-y-auto p-4"
        )}
      >
        {children}
      </div>
    </div>
  );
}
