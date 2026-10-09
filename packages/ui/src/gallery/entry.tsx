import type { ReactNode } from "react";
import type { GalleryText } from "./text";

/** One gallery entry: the exported components it shows and how it shows them. */
export interface GalleryEntry {
  /** The component's name as it is imported. It is the entry's heading unless `heading` is set. */
  name: string;
  /** A translated heading, for foundations that are not components. */
  heading?(text: GalleryText): string;
  /** Every export of the library this entry covers. A test holds the list complete. */
  components: readonly string[];
  render(text: GalleryText): ReactNode;
}

export type GalleryGroupId =
  | "foundations"
  | "actions"
  | "forms"
  | "overlays"
  | "navigation"
  | "structure"
  | "data"
  | "status"
  | "feedback";

export interface GalleryGroup {
  id: GalleryGroupId;
  entries: readonly GalleryEntry[];
}

/** A labelled row of samples inside an entry. */
export function Samples({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      {label === undefined ? null : (
        <span className="text-caption font-medium text-muted-foreground">{label}</span>
      )}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
