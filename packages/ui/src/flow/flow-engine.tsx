import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type ReactFlowState
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { SidePanelPlacementContext } from "../overlays/side-panel";
import { FlowControls, type FlowControlsSearch } from "./flow-controls";
import {
  EngineContext,
  FLOW_COMPACT_ZOOM,
  edgeTypes,
  nodeTypes,
  type EngineContextValue,
  type GroupRfNode,
  type NodeEnds,
  type RfEdge,
  type StepRfNode
} from "./flow-engine-nodes";
import {
  fitFlowViewport,
  layoutFlow,
  panIntoView,
  type FlowInsets,
  type FlowLayout,
  type FlowSize,
  type FlowViewport
} from "./flow-layout";
import { FlowMinimap, type FlowBox, type FlowMinimapItem } from "./flow-minimap";
import type { FlowDirection, FlowGraph, FlowStatus } from "./flow-types";

const MIN_ZOOM = 0.2;
const HIDE_ATTRIBUTION = { hideAttribution: true };
const MAX_ZOOM = 2;
/** How far a press may drag the view, in pixels, and still be a press and no move. */
const MOVE_SLACK = 3;
/** How long the view takes to move where the token of an opening surface cannot be read. */
const PAN_DURATION_FALLBACK = 200;

/**
 * How long the view takes to move, in milliseconds: the library's duration of a surface that
 * opens, so the canvas makes room at the pace its panel arrives. Nothing moves under reduced
 * motion.
 */
function panDuration(): number {
  if (prefersReducedMotion()) {
    return 0;
  }
  const token = getComputedStyle(document.documentElement)
    .getPropertyValue("--duration-open")
    .trim();
  const value = Number.parseFloat(token);
  if (!Number.isFinite(value)) {
    return PAN_DURATION_FALLBACK;
  }
  return token.endsWith("ms") ? value : value * 1000;
}

export interface FlowEngineProps {
  graph: FlowGraph;
  direction: FlowDirection;
  /** The size of the canvas in pixels. */
  size: FlowSize;
  /** The canvas is too narrow for a search field, a minimap and a panel at its side. */
  narrow: boolean;
  label: string;
  selectedId?: string;
  onSelect?(id: string | undefined): void;
  onAction?(id: string): void;
  /** The wheel scrolls the page around the canvas. Pinching and the controls zoom. */
  embedded: boolean;
  controls: boolean;
  minimap: boolean;
  searchLabel?: string;
  panel?: ReactNode;
}

const noNodeClick = () => undefined;

function endsOf(layout: FlowLayout): Map<string, NodeEnds> {
  const ends = new Map<string, NodeEnds>();
  const of = (id: string): NodeEnds => {
    const known = ends.get(id);
    if (known) {
      return known;
    }
    const fresh: NodeEnds = { in: {}, out: {}, exits: {} };
    ends.set(id, fresh);
    return fresh;
  };
  for (const edge of layout.edges) {
    if (edge.sourceExit === undefined) {
      of(edge.source).out[edge.axis] ??= edge.state;
    } else {
      of(edge.source).exits[edge.sourceExit] ??= edge.state;
    }
    of(edge.target).in[edge.axis] ??= edge.state;
  }
  return ends;
}

const noEnds: NodeEnds = { in: {}, out: {}, exits: {} };

/** A move of the view that nobody waits for. One that is cut short by the next is no error. */
function settled(motion: Promise<unknown>): void {
  motion.catch(() => undefined);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Engine({
  graph,
  direction,
  size,
  narrow,
  label,
  selectedId,
  onSelect,
  onAction,
  embedded,
  controls,
  minimap,
  searchLabel,
  panel
}: FlowEngineProps) {
  const flow = useReactFlow<StepRfNode | GroupRfNode, RfEdge>();
  const updateNodeInternals = useUpdateNodeInternals();
  const rootRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<ReadonlyMap<string, FlowSize>>(new Map());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set((graph.groups ?? []).filter((group) => group.defaultCollapsed).map((g) => g.id))
  );
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string>();
  const [opened, setOpened] = useState(false);
  /** The reader moved the view: the canvas no longer fits it by itself. */
  const movedRef = useRef(false);
  /** Where the view stood when the reader last pressed on the canvas. */
  const pressedRef = useRef<FlowViewport>(undefined);
  const keyboardRef = useRef(false);

  const report = useCallback((id: string, next: FlowSize) => {
    setSizes((current) => {
      const known = current.get(id);
      if (known && known.width === next.width && known.height === next.height) {
        return current;
      }
      return new Map(current).set(id, next);
    });
  }, []);
  /** The group the reader just folded or unfolded, and where its corner stood in the canvas. */
  const heldRef = useRef<{ id: string; x: number; y: number }>(undefined);
  const boxesRef = useRef<FlowLayout["boxes"]>(undefined);
  const toggle = useCallback(
    (id: string) => {
      // Folding changes the layout around the group. The group stays where the reader pressed
      // it, and the view is no longer fitted by itself: the reader arranged it.
      const box = boxesRef.current?.get(id);
      if (box) {
        const view = flow.getViewport();
        heldRef.current = { id, x: box.x * view.zoom + view.x, y: box.y * view.zoom + view.y };
        movedRef.current = true;
      }
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(id)) {
          next.add(id);
        }
        return next;
      });
    },
    [flow]
  );

  const layout = useMemo(
    () => layoutFlow({ graph, direction, sizes, collapsed }),
    [graph, direction, sizes, collapsed]
  );
  const ready = layout.order.every((id) => sizes.has(id));
  useLayoutEffect(() => {
    boxesRef.current = layout.boxes;
    const held = heldRef.current;
    const box = held === undefined ? undefined : layout.boxes.get(held.id);
    if (held === undefined || !box || !ready) {
      return;
    }
    const view = flow.getViewport();
    const x = held.x - box.x * view.zoom;
    const y = held.y - box.y * view.zoom;
    if (x !== view.x || y !== view.y) {
      settled(flow.setViewport({ x, y, zoom: view.zoom }, { duration: 0 }));
    }
  }, [layout, ready, flow]);

  const { nodes, edges } = useMemo(() => {
    const groups = new Map((graph.groups ?? []).map((group) => [group.id, group]));
    const steps = new Map(graph.nodes.map((node) => [node.id, node]));
    const ends = endsOf(layout);
    const built: (StepRfNode | GroupRfNode)[] = [];
    for (const id of layout.order) {
      const box = layout.boxes.get(id);
      if (!box) {
        continue;
      }
      const group = groups.get(id);
      const step = steps.get(id);
      const parentId = (group ?? step)?.parentId;
      const parentBox = parentId === undefined ? undefined : layout.boxes.get(parentId);
      const shared = {
        id,
        position: { x: box.x - (parentBox?.x ?? 0), y: box.y - (parentBox?.y ?? 0) },
        parentId: parentBox === undefined ? undefined : parentId,
        // Until every part has reported its size the engine keeps them all unseen.
        measured: ready ? { width: box.width, height: box.height } : undefined,
        draggable: false,
        selectable: false,
        focusable: false,
        connectable: false
      };
      const marked = id === selectedId || id === found;
      if (group) {
        built.push({
          ...shared,
          type: "container",
          data: {
            item: group,
            marked,
            ends: ends.get(id) ?? noEnds,
            box: { width: box.width, height: box.height }
          }
        });
      } else if (step) {
        built.push({
          ...shared,
          type: "step",
          data: { item: step, marked, ends: ends.get(id) ?? noEnds, direction }
        });
      }
    }
    const joined: RfEdge[] = layout.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceExit === undefined ? `out-${edge.axis}` : `exit:${edge.sourceExit}`,
      targetHandle: `in-${edge.axis}`,
      type: "flow",
      data: { state: edge.state, label: edge.label, waypoints: edge.waypoints },
      focusable: false,
      selectable: false
    }));
    return { nodes: built, edges: joined };
  }, [graph, layout, ready, selectedId, found, direction]);

  // A handle that appears or moves without its node changing size is measured again.
  useEffect(() => {
    if (ready) {
      updateNodeInternals([...layout.order]);
    }
  }, [layout, ready, updateNodeInternals]);

  const chromeInsets = useMemo<FlowInsets>(
    () =>
      narrow
        ? { top: 16, right: 16, bottom: controls ? 72 : 16, left: 16 }
        : { top: 32, right: 32, bottom: controls || minimap ? 76 : 32, left: 32 },
    [narrow, controls, minimap]
  );

  /** What the panel covers of the canvas, in pixels from its right and from its bottom edge. */
  const panelCover = useCallback((): { right: number; bottom: number } => {
    const panelElement = rootRef.current?.querySelector<HTMLElement>('[data-slot="side-panel"]');
    if (!panelElement) {
      return { right: 0, bottom: 0 };
    }
    return panelElement.dataset.placement === "sheet"
      ? { right: 0, bottom: panelElement.offsetHeight }
      : { right: Math.max(0, size.width - panelElement.offsetLeft), bottom: 0 };
  }, [size]);

  /** The part of the canvas no panel covers, in pixels of the canvas. */
  const freeArea = useCallback((): FlowBox => {
    const margin = narrow ? 16 : 24;
    const cover = panelCover();
    return {
      x: margin,
      y: margin,
      width: size.width - cover.right - 2 * margin,
      height: size.height - cover.bottom - 2 * margin
    };
  }, [narrow, size, panelCover]);

  /** The view moved by the least distance that shows the node, or the view itself. */
  const showing = useCallback(
    (view: FlowViewport, id: string): FlowViewport => {
      const box = layout.boxes.get(id);
      if (!box) {
        return view;
      }
      const move = panIntoView(
        {
          x: box.x * view.zoom + view.x,
          y: box.y * view.zoom + view.y,
          width: box.width * view.zoom,
          height: box.height * view.zoom
        },
        freeArea()
      );
      return { x: view.x + move.x, y: view.y + move.y, zoom: view.zoom };
    },
    [layout.boxes, freeArea]
  );

  /**
   * Fits the graph into what the panel leaves free, so an open panel covers no step of a graph
   * that fits beside it. Where the graph is too large for that, `shown` is the node the view
   * keeps clear of the panel.
   */
  const fit = useCallback(
    (animate: boolean, shown?: string) => {
      const cover = panelCover();
      const fitted = fitFlowViewport(
        layout.bounds,
        size,
        {
          ...chromeInsets,
          right: chromeInsets.right + cover.right,
          bottom: Math.max(chromeInsets.bottom, cover.bottom + chromeInsets.top)
        },
        direction,
        MIN_ZOOM,
        FLOW_COMPACT_ZOOM
      );
      settled(
        flow.setViewport(shown === undefined ? fitted : showing(fitted, shown), {
          duration: animate ? panDuration() : 0
        })
      );
    },
    [flow, layout.bounds, size, chromeInsets, direction, panelCover, showing]
  );

  /** Moves the view by the least distance that shows the node, and not at all when it shows. */
  const reveal = useCallback(
    (id: string, animate: boolean) => {
      const view = flow.getViewport();
      const next = showing(view, id);
      if (next.x !== view.x || next.y !== view.y) {
        heldRef.current = undefined;
        settled(flow.setViewport(next, { duration: animate ? panDuration() : 0 }));
      }
    },
    [flow, showing]
  );

  // Opening fits the whole graph. So does a change of the canvas' size or direction, until the
  // reader moves the view.
  const fitRef = useRef(fit);
  const revealRef = useRef(reveal);
  const selectedRef = useRef(selectedId);
  useLayoutEffect(() => {
    fitRef.current = fit;
    revealRef.current = reveal;
    selectedRef.current = selectedId;
  });
  useLayoutEffect(() => {
    if (!ready || movedRef.current) {
      return;
    }
    // What is selected when the canvas opens is shown clear of its panel.
    fitRef.current(false, selectedRef.current);
    setOpened(true);
  }, [ready, size.width, size.height, direction]);

  // A panel that opens or closes is given room: until the reader moves the view, the graph is
  // fitted again into what is free, so the panel covers no step. After that selecting never
  // zooms, and pans only when the selected node would stand under the panel.
  const previousSelected = useRef(selectedId);
  useEffect(() => {
    const previous = previousSelected.current;
    previousSelected.current = selectedId;
    if (previous === selectedId || !opened) {
      return;
    }
    const root = rootRef.current;
    if (selectedId !== undefined) {
      if (movedRef.current) {
        revealRef.current(selectedId, true);
      } else {
        fitRef.current(true, selectedId);
      }
      if (keyboardRef.current) {
        root?.querySelector<HTMLElement>('[data-slot="side-panel"]')?.focus();
      }
      return;
    }
    if (!movedRef.current) {
      fitRef.current(true);
    }
    // The panel closed with the focus in it: the focus returns to the node it was about.
    const active = root?.ownerDocument.activeElement;
    if (previous !== undefined && (!active || active === root?.ownerDocument.body)) {
      nodeElement(root, previous)?.focus({ preventScroll: true });
    }
  }, [selectedId, opened]);

  const select = useCallback(
    (id: string) => {
      setFound(undefined);
      onSelect?.(id);
    },
    [onSelect]
  );
  const engine = useMemo<EngineContextValue>(
    () => ({
      select,
      act: (id) => onAction?.(id),
      report,
      collapsed,
      toggle,
      selectable: onSelect !== undefined
    }),
    [select, onAction, report, collapsed, toggle, onSelect]
  );

  const matches = useMemo(() => {
    const wanted = query.trim().toLocaleLowerCase();
    if (wanted === "") {
      return [];
    }
    const titles = new Map(
      [...graph.nodes, ...(graph.groups ?? [])].map((item) => [item.id, item.title])
    );
    return layout.order.filter((id) => titles.get(id)?.toLocaleLowerCase().includes(wanted));
  }, [query, graph, layout.order]);

  const goToMatch = () => {
    if (matches.length === 0) {
      return;
    }
    const next = matches[(found === undefined ? -1 : matches.indexOf(found)) + 1] ?? matches[0];
    const box = next === undefined ? undefined : layout.boxes.get(next);
    if (next === undefined || !box) {
      return;
    }
    setFound(next);
    movedRef.current = true;
    heldRef.current = undefined;
    const view = flow.getViewport();
    // A match is shown large enough to read, in the middle of what is free.
    const zoom = Math.max(view.zoom, 1);
    const free = freeArea();
    settled(
      flow.setViewport(
        {
          x: free.x + free.width / 2 - (box.x + box.width / 2) * zoom,
          y: free.y + free.height / 2 - (box.y + box.height / 2) * zoom,
          zoom
        },
        { duration: panDuration() }
      )
    );
  };

  const minimapItems = useMemo<FlowMinimapItem[]>(() => {
    const statuses = new Map<string, FlowStatus | undefined>(
      graph.nodes.map((node) => [node.id, node.status])
    );
    const groupIds = new Set((graph.groups ?? []).map((group) => group.id));
    return layout.order.flatMap((id) => {
      const box = layout.boxes.get(id);
      return box
        ? [{ id, ...box, status: statuses.get(id), group: groupIds.has(id) && !collapsed.has(id) }]
        : [];
    });
  }, [graph, layout, collapsed]);

  const panelShown = panel !== undefined && panel !== null && panel !== false;

  return (
    <EngineContext value={engine}>
      <div
        ref={rootRef}
        data-slot="flow-engine"
        data-ready={opened ? "" : undefined}
        data-direction={direction}
        className={cn(
          "absolute inset-0 transition-opacity duration-(--duration-color) motion-reduce:transition-none",
          opened ? "opacity-100" : "opacity-0"
        )}
        onKeyDownCapture={() => {
          keyboardRef.current = true;
        }}
        onPointerDownCapture={() => {
          keyboardRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && selectedId !== undefined && !event.defaultPrevented) {
            onSelect?.(undefined);
            nodeElement(rootRef.current, selectedId)?.focus({ preventScroll: true });
          }
        }}
        onFocusCapture={(event) => {
          // A node that takes the focus outside the view is brought into it by the view, not
          // by the browser scrolling the canvas' boxes.
          const id = event.target instanceof HTMLElement ? event.target.dataset.flowId : undefined;
          if (id !== undefined && keyboardRef.current) {
            reveal(id, true);
          }
        }}
        onScrollCapture={(event) => {
          if (event.target instanceof HTMLElement && event.target !== event.currentTarget) {
            const scrolled = event.target;
            if (scrolled.closest(".react-flow") && !scrolled.closest('[data-slot="side-panel"]')) {
              scrolled.scrollTo(0, 0);
            }
          }
        }}
      >
        <ReactFlow
          aria-label={label}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          disableKeyboardA11y
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
          panOnScroll={!embedded}
          preventScrolling={!embedded}
          // The canvas shows no mark of the library it is drawn with: its MIT licence asks for
          // none on the page.
          proOptions={HIDE_ATTRIBUTION}
          // With a handler a node takes pointer events, which its own controls need.
          onNodeClick={noNodeClick}
          onPaneClick={() => {
            setFound(undefined);
            if (selectedId !== undefined) {
              onSelect?.(undefined);
            }
          }}
          // A press on a step begins a move that goes nowhere. The view counts as the
          // reader's own once it has left where the press found it.
          onMoveStart={(event, view) => {
            pressedRef.current = event ? view : undefined;
          }}
          onMove={(event, view) => {
            const pressed = pressedRef.current;
            if (
              event &&
              pressed &&
              (view.zoom !== pressed.zoom ||
                Math.abs(view.x - pressed.x) + Math.abs(view.y - pressed.y) > MOVE_SLACK)
            ) {
              movedRef.current = true;
              heldRef.current = undefined;
            }
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.5}
            color="color-mix(in srgb, var(--foreground) 16%, transparent)"
          />
          {narrow && controls ? (
            // A narrow canvas has no free corner: a graph taller than it would pass under the
            // controls. They stand on a strip of their own, which the graph ends above.
            <div
              aria-hidden="true"
              data-slot="flow-strip"
              className="absolute inset-x-0 bottom-0 z-4 h-15 border-t bg-background"
            />
          ) : null}
        </ReactFlow>
        {controls && !(narrow && panelShown) ? (
          <EngineControls
            narrow={narrow}
            onFit={() => {
              movedRef.current = false;
              heldRef.current = undefined;
              fit(true);
            }}
            onMoved={() => {
              movedRef.current = true;
              heldRef.current = undefined;
            }}
            search={
              narrow || searchLabel === undefined
                ? undefined
                : {
                    label: searchLabel,
                    value: query,
                    onValueChange: (value) => {
                      setQuery(value);
                      setFound(undefined);
                    },
                    onSubmit: goToMatch
                  }
            }
          />
        ) : null}
        {minimap && !narrow ? (
          <EngineMinimap items={minimapItems} size={size} panel={panelShown} />
        ) : null}
        <SidePanelPlacementContext value={narrow ? "sheet" : "float"}>
          {panel}
        </SidePanelPlacementContext>
      </div>
    </EngineContext>
  );
}

function nodeElement(root: HTMLElement | null, id: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-flow-id="${CSS.escape(id)}"]`) ?? null;
}

const zoomSelector = (state: ReactFlowState) => state.transform[2];

function EngineControls({
  narrow,
  onFit,
  onMoved,
  search
}: {
  narrow: boolean;
  onFit(): void;
  onMoved(): void;
  search: FlowControlsSearch | undefined;
}) {
  const flow = useReactFlow();
  const zoom = useStore(zoomSelector);
  const duration = panDuration;
  return (
    <FlowControls
      className={cn("absolute z-10", narrow ? "bottom-3 left-3" : "bottom-4 left-4")}
      zoom={zoom}
      canZoomIn={zoom < MAX_ZOOM}
      canZoomOut={zoom > MIN_ZOOM}
      onZoomIn={() => {
        onMoved();
        settled(flow.zoomIn({ duration: duration() }));
      }}
      onZoomOut={() => {
        onMoved();
        settled(flow.zoomOut({ duration: duration() }));
      }}
      onFit={onFit}
      search={search}
    />
  );
}

const transformSelector = (state: ReactFlowState) => state.transform;

/** The width of a floating panel with its distance from the canvas' edge. */
const PANEL_SPACE = 392;

function EngineMinimap({
  items,
  size,
  panel
}: {
  items: readonly FlowMinimapItem[];
  size: FlowSize;
  panel: boolean;
}) {
  const [x, y, zoom] = useStore(transformSelector);
  // Beside a panel at the canvas' side, and not at all where the two would meet the controls.
  if (panel && size.width < 960) {
    return null;
  }
  return (
    <FlowMinimap
      className="absolute bottom-4 z-10"
      style={{ right: panel ? PANEL_SPACE + 16 : 16 }}
      items={items}
      viewport={{
        x: -x / zoom,
        y: -y / zoom,
        width: size.width / zoom,
        height: size.height / zoom
      }}
    />
  );
}

/** The canvas as the engine draws it. `FlowCanvas` loads this module when the first one mounts. */
export function FlowEngine(props: FlowEngineProps) {
  return (
    <ReactFlowProvider>
      <Engine {...props} />
    </ReactFlowProvider>
  );
}
