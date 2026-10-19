import { cn } from "../cn";
import type { UiLabels } from "../labels";
import type { FlowChange } from "./flow-types";

export const flowChangeLabels: Record<FlowChange, keyof UiLabels> = {
  new: "changeNew",
  changed: "changeChanged",
  removed: "changeRemoved",
  unsaved: "changeUnsaved"
};

/**
 * The line of the frame a change draws around a part, outside the part's own line, so the
 * status keeps its colour. A removed part has none: it is struck through.
 */
const changeLines: Record<FlowChange, string | undefined> = {
  new: "border-dashed",
  changed: "border-solid",
  removed: undefined,
  unsaved: "border-dashed"
};

/** The frame of a change around a node (`rounded-xl`) or a group (`rounded-2xl`). */
export function FlowChangeFrame({ change, className }: { change?: FlowChange; className: string }) {
  const line = change === undefined ? undefined : changeLines[change];
  return line === undefined ? null : (
    <span
      aria-hidden="true"
      data-slot="flow-change-frame"
      className={cn(
        "pointer-events-none absolute -inset-1.5 border-[1.5px] border-primary",
        line,
        className
      )}
    />
  );
}
