import { useState, type ReactNode } from "react";
import { Button } from "../actions/button";
import { KeyValue, KeyValueList } from "../data/key-value";
import { Progress } from "../feedback/progress";
import { FlowCanvas } from "../flow/flow-canvas";
import { FlowControls } from "../flow/flow-controls";
import { FlowEdge, flowEdgePath } from "../flow/flow-edge";
import { FlowGroup } from "../flow/flow-group";
import { FlowMinimap, type FlowMinimapItem } from "../flow/flow-minimap";
import { FlowHandle, FlowNode } from "../flow/flow-node";
import type { FlowEdgeState, FlowGraph, FlowStatus } from "../flow/flow-types";
import { SidePanel } from "../overlays/side-panel";
import { RegistryIcon } from "../status/registry-icon";
import { useUiLabels } from "../ui-root";
import { Samples, type GalleryEntry, type GalleryGroup } from "./entry";
import { largeGraph, linearGraph } from "./flow-graphs";
import type { GalleryText } from "./text";

/** A box of a fixed height for a canvas, which fills what it is given. */
function CanvasBox({
  sample,
  className,
  children
}: {
  sample: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <div
      data-gallery-sample={sample}
      className={`relative w-full min-w-0 overflow-hidden rounded-lg border ${className}`}
    >
      {children}
    </div>
  );
}

/** A canvas whose nodes open a panel about themselves. */
function SelectableCanvas({
  text,
  graph,
  sample,
  className,
  initial,
  tab
}: {
  text: GalleryText;
  graph: FlowGraph;
  sample: string;
  className: string;
  initial?: string;
  tab: string;
}) {
  const [selectedId, setSelectedId] = useState(initial);
  const [shownTab, setShownTab] = useState(tab);
  const selected =
    graph.nodes.find((node) => node.id === selectedId) ??
    graph.groups?.find((group) => group.id === selectedId);
  return (
    <CanvasBox sample={sample} className={className}>
      <FlowCanvas
        embedded
        graph={graph}
        label={text.flowCanvasLabel}
        emptyLabel={text.flowEmptyLabel}
        searchLabel={text.flowSearch}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onAction={setSelectedId}
        panel={
          selected === undefined ? undefined : (
            <SidePanel
              open
              leading={
                <span className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary [&_svg]:size-4">
                  <RegistryIcon name={selected.icon} />
                </span>
              }
              eyebrow={selected.eyebrow}
              title={selected.title}
              tabsLabel={text.sidePanelTabs}
              tabs={[
                { value: "what", label: text.sidePanelTabWhat },
                { value: "input", label: text.sidePanelTabInput },
                { value: "output", label: text.sidePanelTabOutput }
              ]}
              tab={shownTab}
              onTabChange={setShownTab}
              onClose={() => setSelectedId(undefined)}
            >
              <PanelBody text={text} summary={selected.summary} />
            </SidePanel>
          )
        }
      />
    </CanvasBox>
  );
}

function PanelBody({ text, summary }: { text: GalleryText; summary?: string }) {
  return (
    <>
      {summary === undefined ? null : <p>{summary}</p>}
      <KeyValueList>
        <KeyValue label={text.sidePanelTook}>{text.flowDurationShort}</KeyValue>
        <KeyValue label={text.sidePanelReadFrom}>{text.flowChipBookings}</KeyValue>
        <KeyValue label={text.sidePanelPassesOn}>{text.sidePanelPassesOnValue}</KeyValue>
      </KeyValueList>
      <p className="text-caption text-muted-foreground">{text.sidePanelBody}</p>
    </>
  );
}

function CanvasSamples({ text }: { text: GalleryText }) {
  return (
    <>
      <Samples label={text.flowLinear}>
        <SelectableCanvas
          text={text}
          graph={linearGraph(text)}
          sample="flow-linear"
          className="h-140"
          tab="what"
        />
      </Samples>
      <Samples label={text.flowRun}>
        <SelectableCanvas
          text={text}
          graph={linearGraph(text, "running")}
          sample="flow-run"
          className="h-180"
          initial="load"
          tab="output"
        />
      </Samples>
      <Samples label={text.flowLarge}>
        <SelectableCanvas
          text={text}
          graph={largeGraph(text)}
          sample="flow-large"
          className="h-140"
          tab="what"
        />
      </Samples>
      <Samples label={text.flowFailed}>
        <SelectableCanvas
          text={text}
          graph={linearGraph(text, "failed")}
          sample="flow-failed"
          className="h-140"
          tab="what"
        />
      </Samples>
      <Samples label={text.flowWaiting}>
        <SelectableCanvas
          text={text}
          graph={largeGraph(text, true)}
          sample="flow-waiting"
          className="h-120"
          tab="what"
        />
      </Samples>
      <Samples label={text.flowStates}>
        <div className="grid w-full min-w-0 gap-3 @2xl:grid-cols-2">
          <CanvasBox sample="flow-empty" className="h-48">
            <FlowCanvas
              graph={{ nodes: [], edges: [] }}
              label={text.flowCanvasLabel}
              emptyLabel={text.flowEmptyLabel}
            />
          </CanvasBox>
          <CanvasBox sample="flow-loading" className="h-48">
            <FlowCanvas
              loading
              graph={{ nodes: [], edges: [] }}
              label={text.flowCanvasLabel}
              emptyLabel={text.flowEmptyLabel}
            />
          </CanvasBox>
        </div>
      </Samples>
      <Samples label={text.flowPhone}>
        <div className="w-full max-w-97.5 min-w-0">
          <SelectableCanvas
            text={text}
            graph={linearGraph(text, "done")}
            sample="flow-phone"
            className="h-190"
            initial="load"
            tab="output"
          />
        </div>
      </Samples>
    </>
  );
}

const statuses: readonly FlowStatus[] = ["idle", "running", "waiting", "done", "failed", "skipped"];

function NodeSamples({ text }: { text: GalleryText }) {
  const labels = useUiLabels("NodeSamples");
  const words: Record<FlowStatus, string> = {
    idle: text.flowStatusIdle,
    running: labels.stateRunning,
    waiting: labels.stateWaiting,
    done: labels.stateDone,
    failed: labels.stateFailed,
    skipped: labels.stateSkipped
  };
  const footers: Partial<Record<FlowStatus, string>> = {
    done: text.flowLoadFooter,
    failed: text.flowLoadFailure,
    waiting: text.flowApprovalFooter
  };
  const node = (status: FlowStatus, compact = false) => (
    <FlowNode
      key={`${status}-${String(compact)}`}
      data-gallery-sample={`flow-node-${status}${compact ? "-compact" : ""}`}
      icon={<RegistryIcon name="database" />}
      eyebrow={text.flowKindRead}
      title={text.flowLoadTitle}
      summary={text.flowLoadSummary}
      chip={
        <>
          <RegistryIcon name="connection" />
          <span className="truncate">{text.flowChipBookings}</span>
        </>
      }
      footer={footers[status]}
      meta={status === "done" ? text.flowDurationShort : undefined}
      status={status}
      compact={compact}
      label={`${text.flowKindRead}, ${text.flowLoadTitle}, ${words[status]}`}
    />
  );
  return (
    <>
      <Samples label={text.flowNodeStatuses}>
        <div className="flex w-full min-w-0 flex-wrap items-start gap-6 rounded-lg bg-muted p-6">
          {statuses.map((status) => node(status))}
        </div>
      </Samples>
      <Samples label={text.flowNodeParts}>
        <div className="flex w-full min-w-0 flex-wrap items-start gap-6 rounded-lg bg-muted p-6">
          <FlowNode
            selected
            icon={<RegistryIcon name="schedule" />}
            eyebrow={text.flowKindStart}
            title={text.flowTriggerTitle}
            summary={text.flowTriggerSummary}
            label={`${text.flowKindStart}, ${text.flowTriggerTitle}, ${text.flowSelected}`}
            onOpen={() => undefined}
          />
          <FlowNode
            icon={<RegistryIcon name="branch" />}
            eyebrow={text.flowKindCondition}
            title={text.flowConditionTitle}
            rows={[
              {
                id: "yes",
                label: text.flowExitYes,
                handle: (
                  <FlowHandle
                    state="done"
                    className="absolute top-1/2 -right-px translate-x-1/2 -translate-y-1/2"
                  />
                )
              },
              {
                id: "otherwise",
                label: text.flowExitOtherwise,
                handle: (
                  <FlowHandle
                    state="skipped"
                    className="absolute top-1/2 -right-px translate-x-1/2 -translate-y-1/2"
                  />
                )
              }
            ]}
            status="done"
            label={`${text.flowKindCondition}, ${text.flowConditionTitle}`}
          />
          <FlowNode
            stacked
            icon={<RegistryIcon name="subflow" />}
            eyebrow={text.flowKindSubflow}
            title={text.flowSubflowTitle}
            action={
              <Button size="sm" variant="outline">
                {text.flowOpen}
              </Button>
            }
            label={`${text.flowKindSubflow}, ${text.flowSubflowTitle}`}
          />
          <FlowNode
            accent
            icon={<RegistryIcon name="agent" />}
            eyebrow={text.flowKindAgent}
            title={text.flowAgentTitle}
            summary={text.flowAgentSummary}
            label={`${text.flowKindAgent}, ${text.flowAgentTitle}`}
          />
        </div>
      </Samples>
      <Samples label={text.flowNodeCompact}>
        <div className="flex w-full min-w-0 flex-wrap items-start gap-6 rounded-lg bg-muted p-6">
          {(["idle", "running", "done", "failed"] as const).map((status) => node(status, true))}
        </div>
      </Samples>
      <Samples label={text.flowHandleStates}>
        {edgeStates.map((state) => (
          <span key={state} className="flex items-center gap-2 text-caption text-muted-foreground">
            <FlowHandle state={state} />
            {state}
          </span>
        ))}
      </Samples>
    </>
  );
}

function GroupSamples({ text }: { text: GalleryText }) {
  const [collapsed, setCollapsed] = useState(true);
  const child = (
    <FlowNode
      className="w-full"
      icon={<RegistryIcon name="code" />}
      eyebrow={text.flowKindScript}
      title={text.flowCheckTitle}
      summary={text.flowCheckSummary}
      label={`${text.flowKindScript}, ${text.flowCheckTitle}`}
    />
  );
  return (
    <Samples label={text.flowGroupStates}>
      <div className="flex w-full min-w-0 flex-wrap items-start gap-6 rounded-lg bg-muted p-6">
        <FlowGroup
          data-gallery-sample="flow-group-running"
          icon={<RegistryIcon name="repeat" />}
          eyebrow={text.flowKindLoop}
          title={text.flowLoopTitle}
          status="running"
          label={`${text.flowKindLoop}, ${text.flowLoopTitle}`}
          progress={
            <>
              <Progress
                size="sm"
                label={text.flowLoopTitle}
                max={600}
                parts={[
                  { value: 209, tone: "success" },
                  { value: 3, tone: "danger" },
                  { value: 8, tone: "info" }
                ]}
              />
              <p className="text-caption text-muted-foreground">
                <span className="font-medium text-foreground">{text.flowLoopCounts}</span>
                {" · "}
                {text.flowLoopNote}
              </p>
            </>
          }
          action={
            <Button size="sm" variant="outline">
              {text.flowLoopAction}
            </Button>
          }
          onCollapsedChange={() => undefined}
        >
          {child}
        </FlowGroup>
        <FlowGroup
          selected
          icon={<RegistryIcon name="branch" />}
          eyebrow={text.flowKindParallel}
          title={text.flowParallelTitle}
          label={`${text.flowKindParallel}, ${text.flowParallelTitle}, ${text.flowSelected}`}
          onOpen={() => undefined}
        >
          {child}
          {child}
        </FlowGroup>
        <FlowGroup
          data-gallery-sample="flow-group-collapsed"
          icon={<RegistryIcon name="repeat" />}
          eyebrow={text.flowKindLoop}
          title={text.flowLoopTitle}
          summary={text.flowLoopSummary}
          status="done"
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          label={`${text.flowKindLoop}, ${text.flowLoopTitle}, ${text.flowCollapsed}`}
        >
          {child}
        </FlowGroup>
      </div>
    </Samples>
  );
}

const edgeStates: readonly FlowEdgeState[] = ["rest", "done", "active", "skipped"];

function EdgeSamples({ text }: { text: GalleryText }) {
  const path = flowEdgePath({ x: 4, y: 12, side: "right" }, { x: 156, y: 52, side: "left" });
  return (
    <Samples label={text.flowEdgeStates}>
      {edgeStates.map((state) => (
        <span key={state} className="grid gap-1 text-caption text-muted-foreground">
          <svg
            aria-hidden="true"
            data-gallery-sample={`flow-edge-${state}`}
            viewBox="0 0 160 64"
            className="h-16 w-40 rounded-md bg-muted"
          >
            <FlowEdge path={path} state={state} />
          </svg>
          {state}
        </span>
      ))}
    </Samples>
  );
}

function ControlsSamples({ text }: { text: GalleryText }) {
  const [zoom, setZoom] = useState(0.84);
  const [query, setQuery] = useState("");
  const controls = {
    zoom,
    canZoomIn: zoom < 2,
    canZoomOut: zoom > 0.2,
    onZoomIn: () => setZoom((current) => Math.min(2, current + 0.1)),
    onZoomOut: () => setZoom((current) => Math.max(0.2, current - 0.1)),
    onFit: () => setZoom(0.56)
  };
  return (
    <>
      <Samples label={text.flowControlsFull}>
        <div className="w-full min-w-0 rounded-lg bg-muted p-4">
          <FlowControls
            {...controls}
            className="flex-wrap"
            onTidy={() => setZoom(1)}
            search={{
              label: text.flowSearch,
              value: query,
              onValueChange: setQuery,
              onSubmit: () => undefined
            }}
          />
        </div>
      </Samples>
      <Samples label={text.flowControlsNarrow}>
        <div className="rounded-lg bg-muted p-4">
          <FlowControls {...controls} />
        </div>
      </Samples>
    </>
  );
}

const minimapItems: readonly FlowMinimapItem[] = [
  { id: "trigger", x: 0, y: 150, width: 216, height: 90, status: "done" },
  { id: "load", x: 264, y: 130, width: 216, height: 130, status: "done" },
  { id: "loop", x: 528, y: 0, width: 244, height: 390, group: true },
  { id: "bookings", x: 542, y: 80, width: 216, height: 90, status: "running" },
  { id: "check", x: 542, y: 185, width: 216, height: 90, status: "failed" },
  { id: "save", x: 542, y: 290, width: 216, height: 90, status: "waiting" },
  { id: "agent", x: 820, y: 150, width: 216, height: 90 },
  { id: "result", x: 1084, y: 160, width: 216, height: 70, status: "skipped" }
];

function MinimapSamples({ text }: { text: GalleryText }) {
  return (
    <Samples label={text.flowMinimapSample}>
      <div className="rounded-lg bg-muted p-4">
        <FlowMinimap items={minimapItems} viewport={{ x: 200, y: -40, width: 760, height: 470 }} />
      </div>
    </Samples>
  );
}

const flowEntries: readonly GalleryEntry[] = [
  {
    name: "FlowCanvas",
    components: ["FlowCanvas"],
    render: (text) => <CanvasSamples text={text} />
  },
  {
    name: "FlowNode",
    components: ["FlowNode", "FlowHandle"],
    render: (text) => <NodeSamples text={text} />
  },
  {
    name: "FlowGroup",
    components: ["FlowGroup"],
    render: (text) => <GroupSamples text={text} />
  },
  {
    name: "FlowEdge",
    components: ["FlowEdge"],
    render: (text) => <EdgeSamples text={text} />
  },
  {
    name: "FlowControls",
    components: ["FlowControls"],
    render: (text) => <ControlsSamples text={text} />
  },
  {
    name: "FlowMinimap",
    components: ["FlowMinimap"],
    render: (text) => <MinimapSamples text={text} />
  }
];

export const flowGallery: GalleryGroup = { id: "flow", entries: flowEntries };

/** The side panel alone, in a box that stands for its container, in both placements. */
export function SidePanelSamples({ text }: { text: GalleryText }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState("what");
  const panel = (mode: "float" | "sheet") => (
    <div
      data-gallery-sample={`side-panel-${mode}`}
      className="relative h-110 w-full min-w-0 overflow-hidden rounded-lg border bg-muted p-4"
    >
      <Button variant="outline" onClick={() => setOpen(true)}>
        {text.sidePanelOpen}
      </Button>
      <SidePanel
        open={open}
        mode={mode}
        leading={
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary [&_svg]:size-4">
            <RegistryIcon name="database" />
          </span>
        }
        eyebrow={text.flowKindRead}
        title={text.flowLoadTitle}
        tabsLabel={text.sidePanelTabs}
        tabs={[
          { value: "what", label: text.sidePanelTabWhat },
          { value: "input", label: text.sidePanelTabInput },
          { value: "entries", label: text.sidePanelTabEntries, count: 3 }
        ]}
        tab={tab}
        onTabChange={setTab}
        onClose={() => setOpen(false)}
      >
        <PanelBody text={text} summary={text.flowLoadSummary} />
      </SidePanel>
    </div>
  );
  return (
    <>
      <Samples label={text.sidePanelFloat}>{panel("float")}</Samples>
      <Samples label={text.sidePanelSheet}>
        <div className="w-full max-w-97.5 min-w-0">{panel("sheet")}</div>
      </Samples>
    </>
  );
}
