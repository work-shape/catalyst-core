import type { ReactNode } from "react";
import type { BuildScope } from "../../../shared/build-rights";

/** What the reader narrows a list by, as its leading rows are handed it. */
export interface BuildListLeadFilter {
  /** What the reader typed, once they paused. */
  text: string;
  /** The scope the list shows, for a kind that is listed per scope. */
  scope: BuildScope | undefined;
}

/** One row a kind adds before the assets of its list. It looks as theirs do and opens nothing. */
export interface BuildListLeadRow {
  key: string;
  title: string;
  /** The lines under the title, read whole. */
  description: ReactNode;
  /** After the title, as an asset's scope and badges are. */
  chips?: ReactNode;
  /** Always shown at the row's end, such as a switch. */
  actions?: ReactNode;
}

/** The rows a kind adds before the assets of its list. */
export interface BuildListLead {
  /** Absent while they are read. */
  rows: readonly BuildListLeadRow[] | undefined;
  /** What went wrong reading or changing them, shown where a list error is. */
  error?: ReactNode;
}
