import {
  Suspense,
  use,
  useLayoutEffect,
  useState,
  type HTMLAttributes,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { Skeleton } from "../feedback/skeleton";
import { useUiLabels } from "../ui-root";
import { FlowIconProvider, type FlowIconRegistry } from "./flow-icons";
import type { FlowSize } from "./flow-layout";
import type { FlowDirection, FlowGraph } from "./flow-types";

/** Under this width a canvas runs top to bottom and shows a panel as a sheet. */
const FLOW_NARROW_WIDTH = 600;

export interface FlowCanvasProps extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
  /** The graph as plain data. The canvas lays it out; it carries no positions. */
  graph: FlowGraph;
  /** Names the canvas for assistive technology. */
  label: string;
  /** Shown in the canvas when the graph has no nodes. */
  emptyLabel: string;
  /** The graph is still being fetched: the canvas shows its loading layout. */
  loading?: boolean;
  /** Without it the graph runs left to right, and top to bottom on a canvas under 600 px wide. */
  direction?: FlowDirection;
  /** The node or group whose panel is open. */
  selectedId?: string;
  /**
   * Called with a node's id by a press, Enter and Space on it, and with nothing by Escape and a
   * press on the empty canvas. Without it nodes cannot be selected.
   */
  onSelect?(id: string | undefined): void;
  /** Called with the id of the node or group whose `action` was pressed. */
  onAction?(id: string): void;
  /** Icons by key, over the generic ones the library ships. */
  icons?: FlowIconRegistry;
  /**
   * The canvas stands in a page that scrolls: the wheel scrolls the page, and pinching and the
   * controls zoom. Without it the wheel moves the view.
   */
  embedded?: boolean;
  controls?: boolean;
  minimap?: boolean;
  /** Names the field that moves the view to a node by its title. Without it there is no field. */
  searchLabel?: string;
  /**
   * A `SidePanel` about what is selected. The canvas tells it where to stand and keeps the
   * selected node clear of it.
   */
  panel?: ReactNode;
}

type FlowEngineModule = typeof import("./flow-engine");
let flowEngine: Promise<FlowEngineModule | undefined> | undefined;

/**
 * The engine is one chunk, requested when the first canvas mounts. A failed request resolves to
 * `undefined` and is forgotten, so the canvas that asked says so and the next one asks again.
 */
function loadFlowEngine(): Promise<FlowEngineModule | undefined> {
  flowEngine ??= import("./flow-engine").catch(() => {
    flowEngine = undefined;
    return undefined;
  });
  return flowEngine;
}

/**
 * A graph on an area the reader pans and zooms. The layout is automatic and the graph is
 * read-only: a node can be selected, a group folded, nothing moved. It opens showing the whole
 * graph, and below 60 % zoom a node shows its icon and title only. Tab walks the nodes in the
 * order of the flow, Enter opens the selected node's panel and Escape closes it. The canvas
 * fills its box, so the caller gives it a height.
 */
export function FlowCanvas({
  graph,
  label,
  emptyLabel,
  loading = false,
  direction,
  selectedId,
  onSelect,
  onAction,
  icons,
  embedded = false,
  controls = true,
  minimap = true,
  searchLabel,
  panel,
  className,
  ...props
}: FlowCanvasProps) {
  const labels = useUiLabels("FlowCanvas");
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<FlowSize>();
  // One request per mounted canvas: a canvas whose request failed does not ask again by itself.
  const [engine] = useState(loadFlowEngine);
  useLayoutEffect(() => {
    if (!element) {
      return undefined;
    }
    const measure = () =>
      setSize((current) =>
        current?.width === element.clientWidth && current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight }
      );
    measure();
    // In the next frame, so the graph is not laid out again while sizes are still handed out.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [element]);

  const empty = graph.nodes.length === 0 && (graph.groups ?? []).length === 0;
  const narrow = size !== undefined && size.width < FLOW_NARROW_WIDTH;
  const state = loading ? "loading" : empty ? "empty" : "ready";
  const skeleton = <FlowCanvasSkeleton />;

  return (
    <div
      ref={setElement}
      data-slot="flow-canvas"
      data-state={state}
      aria-busy={loading || undefined}
      className={cn(
        "relative isolate size-full min-h-0 min-w-0 overflow-hidden bg-muted text-foreground",
        className
      )}
      {...props}
    >
      {loading ? (
        <>
          {skeleton}
          <span className="sr-only">{labels.loading}</span>
        </>
      ) : empty ? (
        <CanvasNotice>{emptyLabel}</CanvasNotice>
      ) : size === undefined || size.width === 0 || size.height === 0 ? (
        skeleton
      ) : (
        <Suspense fallback={skeleton}>
          <FlowIconProvider icons={icons ?? noIcons}>
            <LoadedEngine
              engine={engine}
              fallback={<CanvasNotice>{labels.flowLoadFailed}</CanvasNotice>}
              graph={graph}
              direction={direction ?? (narrow ? "vertical" : "horizontal")}
              size={size}
              narrow={narrow}
              label={label}
              selectedId={selectedId}
              onSelect={onSelect}
              onAction={onAction}
              embedded={embedded}
              controls={controls}
              minimap={minimap}
              searchLabel={searchLabel}
              panel={panel}
            />
          </FlowIconProvider>
        </Suspense>
      )}
    </div>
  );
}

const noIcons: FlowIconRegistry = {};

type EngineProps = Parameters<FlowEngineModule["FlowEngine"]>[0];

function LoadedEngine({
  engine,
  fallback,
  ...props
}: EngineProps & { engine: Promise<FlowEngineModule | undefined>; fallback: ReactNode }) {
  const loaded = use(engine);
  return loaded ? <loaded.FlowEngine {...props} /> : fallback;
}

/** What the canvas shows in place of a graph: one sentence. */
function CanvasNotice({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="flow-notice"
      className="absolute inset-0 grid place-items-center px-(--layout-gutter) text-center text-body text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** The loading layout: a few frames in a row, joined, where the graph will stand. */
function FlowCanvasSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-slot="flow-skeleton"
      className="absolute inset-0 flex animate-loading-appear items-center justify-center gap-0 overflow-hidden px-8 motion-reduce:animate-none"
    >
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex shrink-0 items-center">
          {index === 0 ? null : <span className="h-px w-10 bg-input" />}
          <span className="flex w-44 flex-col gap-2 rounded-lg border border-input bg-background p-3">
            <span className="flex items-center gap-2.5">
              <Skeleton shape="block" className="size-7" />
              <Skeleton className="w-24" />
            </span>
            <Skeleton className="w-full" />
            <Skeleton className="w-2/3" />
          </span>
        </div>
      ))}
    </div>
  );
}
