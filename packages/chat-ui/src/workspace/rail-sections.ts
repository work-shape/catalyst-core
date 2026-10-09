import { MessageSquare, type LucideIcon } from "lucide-react";
import type { TranslationKey } from "../i18n";
import type { WorkspaceRouteView } from "./workspace-route";

/** A fixed row of the rail that opens a full page. */
export interface RailSection {
  id: string;
  label: TranslationKey;
  icon: LucideIcon;
  /** The view the row opens, and the one it is highlighted on. */
  view: WorkspaceRouteView;
}

/**
 * The section rows in their order. A slice that adds a section adds its row here; whether a
 * module's row shows is decided by the module snapshot, not by this list.
 */
export const railSections: readonly RailSection[] = [
  { id: "chat", label: "nav.chat", icon: MessageSquare, view: "chat" }
];

/** The rows the rail shows: none while there is one section, because a list of one is noise. */
export function shownRailSections(sections: readonly RailSection[]): readonly RailSection[] {
  return sections.length > 1 ? sections : [];
}
