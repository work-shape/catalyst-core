import { LayoutPanelLeft, Minus, Plus, Scan, Search } from "lucide-react";
import type { HTMLAttributes, KeyboardEvent } from "react";
import { IconButton } from "../actions/icon-button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

/** The field that moves the view to a node by its name. */
export interface FlowControlsSearch {
  /** Names the field and stands in it while it is empty. */
  label: string;
  value: string;
  onValueChange(value: string): void;
  /** Called by Enter: go to the match, or to the next one. */
  onSubmit(): void;
}

export interface FlowControlsProps extends HTMLAttributes<HTMLDivElement> {
  /** The zoom as a factor: 1 is full size. */
  zoom: number;
  onZoomIn(): void;
  onZoomOut(): void;
  /** Shows the whole graph. */
  onFit(): void;
  /** Puts the graph back in order. Without it the control is not shown. */
  onTidy?(): void;
  canZoomIn?: boolean;
  canZoomOut?: boolean;
  /** Without it there is no search field, as on a narrow canvas. */
  search?: FlowControlsSearch;
}

const pill =
  "pointer-events-auto flex h-9 items-center rounded-full border border-input bg-background shadow-raised";

/** The controls of a canvas: zoom out, the zoom level, zoom in, fit, tidy, and a search field. */
export function FlowControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onTidy,
  canZoomIn = true,
  canZoomOut = true,
  search,
  className,
  ...props
}: FlowControlsProps) {
  const labels = useUiLabels("FlowControls");
  const submit = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      search?.onSubmit();
    }
  };
  return (
    <div data-slot="flow-controls" className={cn("flex min-w-0 gap-2", className)} {...props}>
      <div className={cn(pill, "px-1")}>
        <IconButton size="sm" label={labels.flowZoomOut} disabled={!canZoomOut} onClick={onZoomOut}>
          <Minus aria-hidden="true" />
        </IconButton>
        <output
          data-slot="flow-zoom"
          className="min-w-10 px-1 text-center text-caption font-medium tabular-nums"
        >
          {Math.round(zoom * 100)}
          {" %"}
        </output>
        <IconButton size="sm" label={labels.flowZoomIn} disabled={!canZoomIn} onClick={onZoomIn}>
          <Plus aria-hidden="true" />
        </IconButton>
        <IconButton size="sm" label={labels.flowFit} onClick={onFit}>
          <Scan aria-hidden="true" />
        </IconButton>
        {onTidy === undefined ? null : (
          <IconButton size="sm" label={labels.flowTidy} onClick={onTidy}>
            <LayoutPanelLeft aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {search === undefined ? null : (
        <label className={cn(pill, "w-48 min-w-0 gap-2 px-3 text-muted-foreground")}>
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <input
            type="search"
            aria-label={search.label}
            placeholder={search.label}
            value={search.value}
            className="h-full min-w-0 flex-1 bg-transparent text-body text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            onChange={(event) => search.onValueChange(event.target.value)}
            onKeyDown={submit}
          />
        </label>
      )}
    </div>
  );
}
