import type { UiLabels } from "../labels";
import type { FlowChange } from "./flow-types";

export const flowChangeLabels: Record<FlowChange, keyof UiLabels> = {
  new: "changeNew",
  changed: "changeChanged",
  removed: "changeRemoved",
  unsaved: "changeUnsaved"
};

export const flowChangeFrames: Record<FlowChange, string> = {
  new: "border-dashed border-primary",
  changed: "border-solid border-primary",
  removed: "",
  unsaved: "border-dashed border-primary"
};
