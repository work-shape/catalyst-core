import type { HTMLAttributes } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

export interface LoadMoreProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The next page is on its way: the button waits and cannot be pressed again. */
  loading: boolean;
  /** Asks for the next page. */
  onLoad(): void;
  /** The button's words. Without them it says the library's "Show more". */
  label?: string;
}

/**
 * The foot of a list that is read a page at a time from a cursor and knows no total: one
 * button that reads the next page. Shown only while more follow; the list grows above it.
 * A list that knows its total takes `Pagination`.
 */
export function LoadMore({ loading, onLoad, label, className, ...props }: LoadMoreProps) {
  const labels = useUiLabels("LoadMore");
  return (
    <div data-slot="load-more" className={cn("flex", className)} {...props}>
      <Button variant="ghost" size="sm" loading={loading} onClick={onLoad}>
        {label ?? labels.showMore}
      </Button>
    </div>
  );
}
