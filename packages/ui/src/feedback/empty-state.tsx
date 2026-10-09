import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

/** `page` fills an empty list or tab; `inline` sits inside a section or a card. */
export type EmptyStateLayout = "page" | "inline";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  layout?: EmptyStateLayout;
  icon?: ReactNode;
  /** One short sentence that says what belongs here. */
  children: ReactNode;
  /** The one primary action. A reader without the right to act gets the sentence alone. */
  action?: ReactNode;
  /** Up to three ready-made starts, shown under the action. */
  presets?: ReactNode;
}

/** What an empty list, tab or section shows. It has no frame. */
export function EmptyState({
  layout = "page",
  icon,
  children,
  action,
  presets,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-layout={layout}
      className={cn(
        "flex flex-col gap-3",
        layout === "page"
          ? "items-center px-(--layout-gutter) py-16 text-center"
          : "items-start py-4",
        className
      )}
      {...props}
    >
      {icon === undefined ? null : (
        <span className="flex text-muted-foreground [&>svg]:size-5">{icon}</span>
      )}
      <p className="max-w-md text-body text-muted-foreground">{children}</p>
      {action === undefined ? null : <div className="flex">{action}</div>}
      {presets === undefined ? null : (
        <div className={cn("flex max-w-xl flex-wrap gap-2", layout === "page" && "justify-center")}>
          {presets}
        </div>
      )}
    </div>
  );
}
