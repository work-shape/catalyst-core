import { Inbox, MessageSquare, type LucideIcon } from "lucide-react";
import type { TranslationKey } from "../i18n";
import type { WorkspaceRouteView } from "./workspace-route";

/**
 * What the rail is given about the sections that are not there for everyone. A section that is
 * absent here does not show.
 */
export interface RailSectionsGiven {
  /** Present for a person who may decide requests or has made one. */
  inbox?: { toDecide: number };
}

/** A fixed row of the rail that opens a full page. */
export interface RailSection {
  id: string;
  label: TranslationKey;
  icon: LucideIcon;
  /** The view the row opens, and the one it is highlighted on. */
  view: WorkspaceRouteView;
  /** Whether the row shows for this person. A row without it shows for everyone. */
  shown?(given: RailSectionsGiven): boolean;
  /** How many things wait in the section. Zero shows no badge. */
  count?(given: RailSectionsGiven): number;
  /** The row's accessible name while it has a count. It takes `{count}`. */
  countLabel?: TranslationKey;
}

/**
 * The section rows in their order. A slice that adds a section adds its row here; whether a
 * module's row shows is decided by the module snapshot, not by this list.
 */
export const railSections: readonly RailSection[] = [
  { id: "chat", label: "nav.chat", icon: MessageSquare, view: "chat" },
  {
    id: "inbox",
    label: "nav.inbox",
    icon: Inbox,
    view: "inbox",
    shown: (given) => given.inbox !== undefined,
    count: (given) => given.inbox?.toDecide ?? 0,
    countLabel: "inbox.railCount"
  }
];

/**
 * The rows the rail shows to this person: none while one section is left, because a list of
 * one is noise.
 */
export function shownRailSections(
  sections: readonly RailSection[],
  given: RailSectionsGiven = {}
): readonly RailSection[] {
  const shown = sections.filter((section) => section.shown?.(given) ?? true);
  return shown.length > 1 ? shown : [];
}
