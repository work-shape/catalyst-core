import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

export interface SurfaceFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** What stands before the name, such as the button that brings the conversation back. */
  leading?: ReactNode;
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
  /** What the surface shows. It scrolls under the header. */
  children?: ReactNode;
}

/**
 * The frame of a working surface: a header as high as every other header, so one line runs
 * across the window, and the content below it. Its slots have one order on every surface:
 * leading, name, subtitle, the kind's actions, fullscreen, close.
 */
export function SurfaceFrame({
  className,
  leading,
  title,
  subtitle,
  actions,
  fullscreen,
  close,
  children,
  ...props
}: SurfaceFrameProps) {
  return (
    <div
      className={cn("flex h-full min-h-0 min-w-0 flex-col bg-card text-card-foreground", className)}
      {...props}
    >
      <header className="flex h-(--layout-header) shrink-0 items-center gap-3 border-b px-4">
        {leading === undefined ? null : (
          <div className="flex shrink-0 items-center gap-2">{leading}</div>
        )}
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2 className="truncate text-heading">{title}</h2>
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
      <div className="min-h-0 flex-1 overflow-y-auto bg-background p-4 [scrollbar-width:thin]">
        {children}
      </div>
    </div>
  );
}
