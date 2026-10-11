import type { ReactNode } from "react";

/**
 * THE FILES SEAM OF THE DRAFT (S3-41).
 *
 * Layout 3 is specified with `Preview | Files`. The Files side needs the source files of a
 * draft revision, which `assets.get` does not answer yet: it has no `revision` and no `files`
 * in its query (gap 1 of CLI-APP-1). Until it does, this seam holds nothing, and the draft
 * screen shows the preview alone, without a switch that would lead to an empty side.
 *
 * Whoever builds the read fills this one export with a component that takes the App and the
 * number of its draft revision and shows the files, the way `PageFiles` does for a Page. The
 * draft screen then shows the switch by itself: nothing else changes there.
 */
export const appDraftFiles:
  ((props: { workspaceId: string; app: string; revision: number }) => ReactNode) | undefined =
  undefined;
