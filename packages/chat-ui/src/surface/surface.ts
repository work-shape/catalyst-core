import type { ReactNode } from "react";

/** One finding of a Page build, as `page.save` reports it. */
export interface PageBuildError {
  file: string;
  line?: number;
  message: string;
}

/** What an already rendered surface carries: its content and the actions of its header. */
interface RenderedSurfaceSource {
  node: ReactNode;
  headerActions?: ReactNode;
  /** An icon of what the surface shows, such as a file's type. It stands before the title. */
  titleIcon?: ReactNode;
}

/**
 * Every kind of surface the slot can hold, with the source fields of each. A kind comes with its
 * renderer in the renderer record.
 */
interface SurfaceSources {
  tool_display: RenderedSurfaceSource;
  file_preview: RenderedSurfaceSource;
  /**
   * One revision of a Page of a conversation. The renderer loads the revision's files itself.
   * `buildErrors` are what the newest save of the Page was refused for, shown under the
   * revision that still stands.
   */
  page: {
    conversationId: string;
    pageId: string;
    fileSetId: string;
    buildErrors?: readonly PageBuildError[];
  };
  /**
   * The published revision of an App. `title` is the name people read. `appPath` is the App's
   * own route to open on; without it the App opens where it starts.
   */
  app_view: { app: string; appPath?: string };
  /** The draft revision of an App, for whoever may write it. */
  app_edit: { app: string };
  /** One Workflow of a workspace on its canvas, as its draft stands, with the bar of the draft. */
  workflow_canvas: { workspaceId: string; workflow: string };
  /** One item of the Inbox, by its id. The renderer reads the item's live state itself. */
  inbox_item: { itemId: string };
}

export type SurfaceKind = keyof SurfaceSources;

/** One member of the surface union. */
export type SurfaceOf<Kind extends SurfaceKind> = {
  kind: Kind;
  /** Identifies the surface: the card that produced it compares this to know it is shown. */
  key: string;
  title: string;
  subtitle?: string;
} & SurfaceSources[Kind];

/** What the surface slot holds: one surface at a time, told apart by `kind`. */
export type Surface = { [Kind in SurfaceKind]: SurfaceOf<Kind> }[SurfaceKind];
