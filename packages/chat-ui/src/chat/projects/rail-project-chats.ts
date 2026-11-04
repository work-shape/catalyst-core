import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationListItem, ProjectView } from "@work-shape/catalyst-api-client";
import { useProjectRailChatsQueries } from "../../shared/api/projects";
import { alphabetically } from "../workspace/rail-order";

// The projects of the rail (PRJ-5, Felix 2026-11-04): each project folds on its own under its
// label. An open project shows its five chats used last, and "Show more" the next ones in place.

/** How many projects of the open workspace the rail lists under "Projects". */
const RAIL_PROJECTS_LIMIT = 5;

/** How many chats an open project shows, and how many more each "Show more" adds. */
const RAIL_PROJECT_CHATS_STEP = 5;

/** The most chats an open project shows: one page of the list, its largest. */
const RAIL_PROJECT_CHATS_MAX = 200;

const RAIL_PROJECTS_OPEN_STORAGE_KEY = "vivd-catalyst:rail-projects-open";

/** How many open projects the browser keeps; the ones opened earliest go first. */
const RAIL_PROJECTS_OPEN_KEPT = 50;

/** A project as the rail lists it. */
export type RailProject = Pick<
  ProjectView,
  "id" | "name" | "title" | "audience" | "collaborationWorkspaceId"
>;

/** What an open project shows under its label. */
export interface RailProjectFold {
  /** Its chats used last, newest first, and the one on screen after them when it is older. */
  chats: readonly ConversationListItem[];
  /** The project has more chats than these: a muted "Show more" follows them. */
  more: boolean;
}

/**
 * The project whose page is open, or whose chat is open on the chat route. Only a project the
 * rail lists can be active: the list holds the projects the person reads.
 */
export function activeRailProject(
  projects: readonly RailProject[] | undefined,
  open: { projectName?: string; conversation?: Pick<ConversationListItem, "projectId"> }
): RailProject | undefined {
  if (!projects) {
    return undefined;
  }
  if (open.projectName !== undefined) {
    return projects.find((project) => project.name === open.projectName);
  }
  const projectId = open.conversation?.projectId;
  return projectId === undefined ? undefined : projects.find(({ id }) => id === projectId);
}

/**
 * The projects the rail lists: the `RAIL_PROJECTS_LIMIT` used last, and the active one when it
 * was used earlier, shown alphabetically so opening one never moves it (Felix, 2026-10-29).
 */
export function railProjectRows<Project extends Pick<RailProject, "id" | "name" | "title">>(
  recentProjects: readonly Project[],
  activeProjectId: string | undefined
): Project[] {
  const listed = recentProjects.slice(0, RAIL_PROJECTS_LIMIT);
  const olderActive =
    activeProjectId === undefined
      ? undefined
      : recentProjects.slice(RAIL_PROJECTS_LIMIT).find(({ id }) => id === activeProjectId);
  return alphabetically(
    olderActive ? [...listed, olderActive] : listed,
    (project) => project.title,
    (project) => project.name
  );
}

/**
 * The chats under an open project's label: its newest `shown`, newest first, and the open one
 * after them when it is older. The rail's loaded rows and the open thread are newer than the
 * project's read, so a chat renamed, moved out or just started shows as it is now. The project
 * has more where the read says so or more are known than shown.
 */
export function railProjectChats(
  projectId: string,
  fetched: readonly ConversationListItem[],
  loaded: readonly ConversationListItem[],
  open: ConversationListItem | undefined,
  shown: number = RAIL_PROJECT_CHATS_STEP,
  fetchedMore = false
): RailProjectFold {
  const byId = new Map<string, ConversationListItem>();
  for (const conversation of [...fetched, ...loaded, ...(open ? [open] : [])]) {
    if (byId.has(conversation.id) || conversation.projectId === projectId) {
      byId.set(conversation.id, conversation);
    }
  }
  const all = [...byId.values()]
    .filter((conversation) => conversation.projectId === projectId)
    .sort(newestFirst);
  const newest = all.slice(0, shown);
  const chats =
    open && open.projectId === projectId && !newest.some(({ id }) => id === open.id)
      ? [...newest, open]
      : newest;
  const more = (fetchedMore || all.length > shown) && shown < RAIL_PROJECT_CHATS_MAX;
  return { chats, more };
}

function newestFirst(a: ConversationListItem, b: ConversationListItem): number {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt < b.updatedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** What the browser keeps of the folds: the ids of the open projects, anything else none. */
export function parseRailProjectsOpen(stored: string | null): readonly string[] {
  if (stored === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
}

/** `open` with the project opened or folded, the one opened last at the end. */
export function railProjectsToggled(open: readonly string[], projectId: string): string[] {
  return open.includes(projectId)
    ? open.filter((id) => id !== projectId)
    : [...open, projectId].slice(-RAIL_PROJECTS_OPEN_KEPT);
}

function readStoredRailProjectsOpen(): readonly string[] {
  try {
    return parseRailProjectsOpen(window.localStorage.getItem(RAIL_PROJECTS_OPEN_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeStoredRailProjectsOpen(open: readonly string[]): void {
  try {
    window.localStorage.setItem(RAIL_PROJECTS_OPEN_STORAGE_KEY, JSON.stringify(open));
  } catch {
    // The folds are a convenience: without the store the projects stand folded on the next visit.
  }
}

/**
 * Which projects of the rail stand open. Folded until the person opens one; their choice is kept
 * in this browser. The project on screen opens without changing the choice, as the Apps fold does.
 */
export function useRailProjectsOpen(activeProjectId: string | undefined): {
  open: readonly string[];
  toggle(projectId: string): void;
} {
  const [open, setOpen] = useState(readStoredRailProjectsOpen);
  const [shownFor, setShownFor] = useState<string | undefined>(undefined);
  // Set while rendering, so the project just opened shows its chats in the same frame.
  if (activeProjectId !== shownFor) {
    setShownFor(activeProjectId);
    if (activeProjectId !== undefined && !open.includes(activeProjectId)) {
      setOpen([...open, activeProjectId]);
    }
  }
  return {
    open,
    toggle: (projectId) => {
      const next = railProjectsToggled(open, projectId);
      writeStoredRailProjectsOpen(next);
      setOpen(next);
    }
  };
}

/**
 * The projects of the rail with their folds: the active one, the open ones with their chats, and
 * the ways to fold one and to show more of one. Each open project's list is read again whenever
 * the rail's list changes, so a chat deleted or moved out goes from under its label too.
 */
export function useRailProjectFolds(input: {
  projects: readonly RailProject[] | undefined;
  openProjectName: string | undefined;
  /** The conversation on screen, while the chat route shows it. */
  openConversation: ConversationListItem | undefined;
  loaded: readonly ConversationListItem[];
}): {
  activeProjectId: string | undefined;
  openProjects: ReadonlyMap<string, RailProjectFold>;
  toggle(projectId: string): void;
  showMore(projectId: string): void;
} {
  const { projects, openProjectName, openConversation, loaded } = input;
  const activeProjectId = activeRailProject(projects, {
    projectName: openProjectName,
    conversation: openConversation
  })?.id;
  const folds = useRailProjectsOpen(activeProjectId);
  const [shown, setShown] = useState<Readonly<Record<string, number>>>({});
  const openRows = useMemo(
    () =>
      railProjectRows(projects ?? [], activeProjectId).filter(({ id }) => folds.open.includes(id)),
    [activeProjectId, folds.open, projects]
  );
  const { results, refresh } = useProjectRailChatsQueries(
    openRows.map((project) => ({
      project,
      limit: Math.min(shown[project.id] ?? RAIL_PROJECT_CHATS_STEP, RAIL_PROJECT_CHATS_MAX)
    }))
  );
  // Only a change of the rail's list asks again; the first read is each query's own.
  const readFor = useRef(loaded);
  useEffect(() => {
    if (readFor.current === loaded) {
      return;
    }
    readFor.current = loaded;
    refresh().catch(() => undefined);
  }, [loaded, refresh]);
  const openProjects = new Map(
    openRows.map((project, index) => {
      const page = results[index]?.data;
      return [
        project.id,
        railProjectChats(
          project.id,
          page?.items ?? [],
          loaded,
          openConversation,
          shown[project.id] ?? RAIL_PROJECT_CHATS_STEP,
          page?.more ?? false
        )
      ] as const;
    })
  );
  return {
    activeProjectId,
    openProjects,
    toggle: folds.toggle,
    showMore: (projectId) =>
      setShown((current) => ({
        ...current,
        [projectId]: (current[projectId] ?? RAIL_PROJECT_CHATS_STEP) + RAIL_PROJECT_CHATS_STEP
      }))
  };
}
