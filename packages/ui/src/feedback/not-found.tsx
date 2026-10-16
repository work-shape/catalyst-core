import { SearchX } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

export interface NotFoundProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** What was looked for. A magnifier that found nothing by default. */
  icon?: ReactNode;
  /** One sentence that says what is not at this address. It is the page's heading. */
  children: ReactNode;
  /** The one next step: a button or a link that leads somewhere that exists. */
  action: ReactNode;
}

/**
 * What a page shows in place of a subject it cannot find: an icon, one sentence and one next
 * step. It stands alone in the page, without the head the subject would have had.
 */
export function NotFound({
  icon = <SearchX aria-hidden="true" />,
  children,
  action,
  className,
  ...props
}: NotFoundProps) {
  return (
    <div
      data-not-found=""
      className={cn(
        "flex min-h-full flex-1 flex-col items-center justify-center gap-3 px-(--layout-gutter) py-16 text-center",
        className
      )}
      {...props}
    >
      <span className="flex text-muted-foreground [&>svg]:size-6">{icon}</span>
      <h1 className="max-w-md text-title-sm text-foreground outline-none">{children}</h1>
      <div className="flex pt-1">{action}</div>
    </div>
  );
}
