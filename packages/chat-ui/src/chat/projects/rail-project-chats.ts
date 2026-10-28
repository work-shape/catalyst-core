import { useEffect, useMemo, useRef } from "react";
import type { ConversationListItem, ProjectView } from "@work-shape/catalyst-api-client";
import { useProjectRailChatsQuery } from "../../shared/api/projects";

// The active project in the rail (PRJ-5): the project whose page or chat is open unfolds to its
// newest chats under its row, so a person moves between a project's chats without its page.

/** How many chats of the active project stand under its row in the rail. */
const RAIL_PROJECT_CHATS_LIMIT = 5;

/** A project as the rail lists it. */
export type RailProject = Pick<
  ProjectView,
  "id" | "name" | "title" | "audience" | "collaborationWorkspaceId"
>;

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
 * The chats under the active project's row: its newest `RAIL_PROJECT_CHATS_LIMIT`, newest first,
 * and the open one after them when it is older. The rail's loaded rows and the open thread are
 * newer than the project's read, so a chat renamed, moved out or just started shows as it is now.
 */
export function railProjectChats(
  projectId: string,
  fetched: readonly ConversationListItem[],
  loaded: readonly ConversationListItem[],
  open: ConversationListItem | undefined
): ConversationListItem[] {
  const byId = new Map<string, ConversationListItem>();
  for (const conversation of [...fetched, ...loaded, ...(open ? [open] : [])]) {
    if (byId.has(conversation.id) || conversation.projectId === projectId) {
      byId.set(conversation.id, conversation);
    }
  }
  const newest = [...byId.values()]
    .filter((conversation) => conversation.projectId === projectId)
    .sort(newestFirst)
    .slice(0, RAIL_PROJECT_CHATS_LIMIT);
  return open && open.projectId === projectId && !newest.some(({ id }) => id === open.id)
    ? [...newest, open]
    : newest;
}

function newestFirst(a: ConversationListItem, b: ConversationListItem): number {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt < b.updatedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The active project of the rail and its chats. The project's list is read again whenever the
 * rail's list changes, so a chat deleted or moved out goes from under the row too.
 */
export function useRailProjectChats(input: {
  projects: readonly RailProject[] | undefined;
  openProjectName: string | undefined;
  /** The conversation on screen, while the chat route shows it. */
  openConversation: ConversationListItem | undefined;
  loaded: readonly ConversationListItem[];
}): { project: RailProject; chats: ConversationListItem[] } | undefined {
  const { projects, openProjectName, openConversation, loaded } = input;
  const project = activeRailProject(projects, {
    projectName: openProjectName,
    conversation: openConversation
  });
  const query = useProjectRailChatsQuery(project, RAIL_PROJECT_CHATS_LIMIT);
  const { refetch } = query;
  const fetching = project !== undefined;
  // Only a change of the rail's list asks again; the first read is the query's own.
  const readFor = useRef(loaded);
  useEffect(() => {
    if (readFor.current === loaded) {
      return;
    }
    readFor.current = loaded;
    if (fetching) {
      refetch().catch(() => undefined);
    }
  }, [fetching, loaded, refetch]);
  const fetched = query.data;
  return useMemo(
    () =>
      project
        ? {
            project,
            chats: railProjectChats(project.id, fetched ?? [], loaded, openConversation)
          }
        : undefined,
    [fetched, loaded, openConversation, project]
  );
}
