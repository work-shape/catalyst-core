import { useState } from "react";
import { Button } from "../actions/button";
import { FlowCanvas } from "../flow/flow-canvas";
import { flowChangeLabels } from "../flow/flow-change";
import { FlowInsertPoint } from "../flow/flow-insert-point";
import { FlowGroup } from "../flow/flow-group";
import { FlowNode } from "../flow/flow-node";
import type {
  FlowChange,
  FlowGraph,
  FlowInsertPlace,
  FlowInsertPoints,
  FlowStatus
} from "../flow/flow-types";
import { Field } from "../forms/field";
import { Input, Textarea } from "../forms/input";
import { SaveBar } from "../forms/save-bar";
import { SidePanel } from "../overlays/side-panel";
import { useUiLabels } from "../ui-root";
import { Samples, type GalleryEntry } from "./entry";
import { largeGraph } from "./flow-graphs";
import type { GalleryText } from "./text";

const changes: readonly FlowChange[] = ["new", "changed", "removed", "unsaved"];
const statuses: readonly FlowStatus[] = [
  "idle",
  "running",
  "waiting",
  "done",
  "doneWithFailures",
  "failed",
  "skipped"
];

function ChangeSamples({ text }: { text: GalleryText }) {
  const labels = useUiLabels("ChangeSamples");
  const [selected, setSelected] = useState("");
  return (
    <div className="flex flex-wrap items-start gap-5">
      {changes.map((change) => (
        <div key={change} className="grid gap-4">
          {statuses.map((status) => (
            <div key={status} className="grid gap-4">
              <FlowNode
                change={change}
                status={status}
                title={text.flowLoadTitle}
                summary={text.flowLoadSummary}
                oldSummary={text.flowLoadFooter}
                label={`${text.flowLoadTitle}, ${labels[flowChangeLabels[change]]}`}
                selected={selected === `node-${change}-${status}`}
                onOpen={() => setSelected(`node-${change}-${status}`)}
              />
              <FlowGroup
                change={change}
                status={status}
                title={text.flowLoopTitle}
                summary={text.flowLoopSummary}
                oldSummary={text.flowLoopNote}
                label={`${text.flowLoopTitle}, ${labels[flowChangeLabels[change]]}`}
                collapsed
                selected={selected === `group-${change}-${status}`}
                onOpen={() => setSelected(`group-${change}-${status}`)}
              />
            </div>
          ))}
          <FlowNode
            change={change}
            title={text.flowLoadTitle}
            compact
            label={text.flowLoadTitle}
            onOpen={() => setSelected(change)}
          />
          <FlowGroup
            change={change}
            title={text.flowLoopTitle}
            compact
            collapsed
            label={text.flowLoopTitle}
            onOpen={() => setSelected(change)}
          />
        </div>
      ))}
    </div>
  );
}

const named = (template: string, name: string) => template.replace("{name}", name);

function InsertSamples({ text }: { text: GalleryText }) {
  const [selected, setSelected] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <FlowInsertPoint
        label={named(text.flowAddAfter, text.flowLoadTitle)}
        onClick={() => setSelected(!selected)}
        aria-pressed={selected}
      />
      <FlowInsertPoint
        label={named(text.flowMoveAfter, text.flowLoadTitle)}
        target
        onClick={() => setSelected(!selected)}
      />
      <FlowInsertPoint label={named(text.flowAddAfter, text.flowLoadTitle)} disabled />
    </div>
  );
}

/** The words of a place, from the titles of the parts it lies by. */
function placeWords(graph: FlowGraph, text: GalleryText, place: FlowInsertPlace, move: boolean) {
  const title = (id: string) =>
    [...graph.nodes, ...(graph.groups ?? [])].find((item) => item.id === id)?.title ?? id;
  switch (place.kind) {
    case "edge":
      return named(move ? text.flowMoveAfter : text.flowAddAfter, title(place.source));
    case "exit": {
      const exit = graph.nodes
        .find((node) => node.id === place.nodeId)
        ?.exits?.find((candidate) => candidate.id === place.exitId);
      return named(text.flowAddOnExit, exit?.label ?? place.exitId);
    }
    case "end":
      return named(text.flowAddAtEnd, title(place.groupId));
  }
}

/** A draft whose insert points report their place, and turn into targets while a step moves. */
function InsertCanvas({ text, moving: startMoving }: { text: GalleryText; moving: boolean }) {
  const [moving, setMoving] = useState(startMoving);
  const [pressed, setPressed] = useState<string>();
  const graph = largeGraph(text);
  const draft: FlowGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === "check" ? { ...node, change: "new" } : node))
  };
  const insertPoints: FlowInsertPoints = {
    mode: moving ? "move" : "add",
    label: (place) => placeWords(draft, text, place, moving),
    // A step does not move next to where it stands.
    shows: (place) => !moving || !(place.kind === "edge" && place.source === "check"),
    onPress: (place) => {
      setPressed(placeWords(draft, text, place, moving));
      setMoving(false);
    },
    onCancel: () => setMoving(false)
  };
  return (
    <div className="grid w-full min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => setMoving(!moving)}>
          {moving ? text.flowMoveCancel : text.flowMoveStep}
        </Button>
        <p aria-live="polite" className="text-caption text-muted-foreground">
          {pressed === undefined ? null : named(text.flowPressed, pressed)}
        </p>
      </div>
      <div
        data-gallery-sample={startMoving ? "flow-insert-move" : "flow-insert-add"}
        className="relative h-140 w-full min-w-0 overflow-hidden rounded-lg border"
      >
        <FlowCanvas
          embedded
          graph={draft}
          label={text.flowCanvasLabel}
          emptyLabel={text.flowEmptyLabel}
          onSelect={() => undefined}
          insertPoints={insertPoints}
        />
      </div>
    </div>
  );
}

function PanelSample({ text, tall }: { text: GalleryText; tall: boolean }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState("settings");
  const [saved, setSaved] = useState(false);
  return (
    <div className="grid w-full gap-2">
      <Button variant="outline" onClick={() => setOpen(true)}>
        {text.flowOpen}
      </Button>
      <div
        className="relative h-160 w-full overflow-hidden rounded-lg border"
        data-gallery-sample={tall ? "side-panel-tall" : "side-panel-footer"}
      >
        <SidePanel
          open={open}
          tall={tall}
          title={text.flowLoadTitle}
          onClose={() => setOpen(false)}
          tab={tab}
          onTabChange={setTab}
          tabsLabel={text.settings}
          tabs={[
            { value: "settings", label: text.settings },
            { value: "details", label: text.description }
          ]}
          footer={
            <SaveBar
              className="px-4"
              label={text.saveChanges}
              saved={saved}
              savedLabel={text.saveSaved}
              discardLabel={text.cancel}
              onDiscard={() => setSaved(false)}
              onSave={() => setSaved(true)}
            />
          }
        >
          <Field label={text.name}>
            <Input defaultValue={text.flowLoadTitle} onChange={() => setSaved(false)} />
          </Field>
          <Field label={text.description}>
            <Textarea
              className="min-h-160"
              defaultValue={text.flowLoadSummary}
              onChange={() => setSaved(false)}
            />
          </Field>
        </SidePanel>
      </div>
    </div>
  );
}

export const editingFlowEntries: readonly GalleryEntry[] = [
  {
    name: "Flow change marks",
    heading: (text) => text.flowChanges,
    components: [],
    render: (text) => <ChangeSamples text={text} />
  },
  {
    name: "FlowInsertPoint",
    components: ["FlowInsertPoint"],
    render: (text) => (
      <div className="grid w-full min-w-0 gap-5">
        <InsertSamples text={text} />
        <Samples label={text.flowEditCanvas}>
          <InsertCanvas text={text} moving={false} />
        </Samples>
        <Samples label={text.flowMoveCanvas}>
          <InsertCanvas text={text} moving />
        </Samples>
      </div>
    )
  },
  {
    name: "SidePanel editing",
    heading: (text) => text.sidePanelEditing,
    components: [],
    render: (text) => (
      <div className="grid w-full gap-5">
        <PanelSample text={text} tall={false} />
        <PanelSample text={text} tall />
      </div>
    )
  }
];
