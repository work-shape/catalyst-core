import { useState } from "react";
import { Button } from "../actions/button";
import { flowChangeLabels } from "../flow/flow-change";
import { FlowInsertPoint } from "../flow/flow-insert-point";
import { FlowGroup } from "../flow/flow-group";
import { FlowNode } from "../flow/flow-node";
import type { FlowChange, FlowStatus } from "../flow/flow-types";
import { Field } from "../forms/field";
import { Input, Textarea } from "../forms/input";
import { SaveBar } from "../forms/save-bar";
import { SidePanel } from "../overlays/side-panel";
import { useUiLabels } from "../ui-root";
import type { GalleryEntry } from "./entry";
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

function InsertSamples({ text }: { text: GalleryText }) {
  const labels = useUiLabels("InsertSamples");
  const [selected, setSelected] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <FlowInsertPoint
        label={`${text.addItem}: ${text.flowLoadTitle}`}
        onClick={() => setSelected(!selected)}
        aria-pressed={selected}
      />
      <FlowInsertPoint label={labels.moveHere} target onClick={() => setSelected(!selected)} />
      <FlowInsertPoint label={text.disabled} disabled />
      <FlowInsertPoint label={text.addItem} hidden />
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
    render: (text) => <InsertSamples text={text} />
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
