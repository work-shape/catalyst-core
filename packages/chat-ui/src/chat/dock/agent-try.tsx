import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { FlaskConical } from "lucide-react";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import type { PageHeaderAction } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { WorkspaceDock } from "../workspace/use-workspace-dock";
import { tryConversationGone, type DockTab } from "./dock-try";

/** The agent an agent's page offers to try, for a reader who holds its write right. */
export interface AgentTryTarget {
  /** The agent under construction, by its name. */
  agent: string;
  /** The name people read for the agent. */
  title: string;
  /** The workspace that owns the agent, by its id. Absent for the instance's own. */
  workspaceId?: string | undefined;
  /** The draft's revision as the page read it: `null` without a draft, undefined while read. */
  draftRevision: number | null | undefined;
}

/** What Try runs for the next turn, as the agent's page knows its draft. */
export type TryRuns = { source: "draft"; revision: number } | { source: "live" };

/** What the dock's head shows of Build and Try on an agent's page. */
export interface AgentTryView {
  tab: DockTab;
  select(tab: DockTab): void;
  /** The name people read for the agent under construction. */
  title: string;
  /** Undefined while the page reads the draft. */
  runs: TryRuns | undefined;
}

/** The Try conversation of the dock, while it shows Try. */
export interface AgentTryPaneState {
  agent: string;
  /** The instance is opening the conversation. */
  opening: boolean;
  /** Opening the conversation failed. */
  failed: boolean;
  retry(): void;
}

interface AgentTryHost {
  offer(target: AgentTryTarget | undefined): void;
  /** Shows Try in the dock; absent while the dock is open, its tabs in its head. */
  open: (() => void) | undefined;
}

const AgentTryHostContext = createContext<AgentTryHost | undefined>(undefined);

/** Gives the agent's page the way to offer Try in the dock. */
export const AgentTryHostProvider = AgentTryHostContext.Provider;

/**
 * Offers Try in the dock while the agent's page shows, and gives the page the way to show it,
 * absent while the dock is open with Build and Try in its head. Without a target the page
 * offers nothing.
 */
export function useOfferAgentTry(target: AgentTryTarget | undefined): (() => void) | undefined {
  const host = useContext(AgentTryHostContext);
  const offer = host?.offer;
  const agent = target?.agent;
  const title = target?.title;
  const workspaceId = target?.workspaceId;
  const draftRevision = target?.draftRevision;
  useEffect(() => {
    offer?.(
      agent === undefined || title === undefined
        ? undefined
        : { agent, title, ...(workspaceId === undefined ? {} : { workspaceId }), draftRevision }
    );
  }, [offer, agent, title, workspaceId, draftRevision]);
  useEffect(() => () => offer?.(undefined), [offer]);
  return target === undefined ? undefined : host?.open;
}

/** "Try" in the head of the agent's page, while the dock does not show its tabs. */
export function useAgentTryAction(
  target: AgentTryTarget | undefined
): PageHeaderAction | undefined {
  const { t } = useTranslation();
  const open = useOfferAgentTry(target);
  return open === undefined
    ? undefined
    : { label: t("dock.tabTry"), icon: <FlaskConical aria-hidden="true" />, onSelect: open };
}

/** What Try runs for the next turn: the draft the page read, or the live agent without one. */
export function tryRunsOf(draftRevision: number | null | undefined): TryRuns | undefined {
  if (draftRevision === undefined) return undefined;
  return draftRevision === null ? { source: "live" } : { source: "draft", revision: draftRevision };
}

/** Opens the reader's own Try conversation with the agent: the same one at every open. */
async function openTryConversation(
  client: ApiClient,
  agent: string,
  workspaceId: string | undefined
): Promise<string> {
  const outcome = await client.agents.try.open({
    params: { name: agent },
    query: workspaceId === undefined ? {} : { workspaceId }
  });
  // Opening Try waits for nobody's decision.
  if (outcome.status !== "done") throw new Error("The instance did not open the Try conversation");
  return outcome.output.conversation.id;
}

/**
 * Build and Try in the dock on an agent's page (section 4.7c). The page offers its agent; Try
 * shows the reader's own Try conversation with it, which the instance opens on the first show.
 * A Publish or a Discard of the draft deletes it: Try then opens a fresh one in its place and
 * never shows the old messages.
 */
export function useAgentTry({ client, dock }: { client: ApiClient; dock: WorkspaceDock }): {
  host: AgentTryHost;
  view: AgentTryView | undefined;
  pane: AgentTryPaneState | undefined;
} {
  const [target, offer] = useState<AgentTryTarget>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The Try conversation opened last, so going back to Try does not open it again.
  const opened = useRef<{ agent: string; conversationId: string } | undefined>(undefined);
  const { showTry, showBuild, tryAgent, tab } = dock;
  const agent = target?.agent;
  const workspaceId = target?.workspaceId;
  const trying = tab === "try" && agent !== undefined && tryAgent === agent;
  const opening = trying && dock.conversationId === undefined;

  useEffect(() => {
    if (!opening || agent === undefined) return undefined;
    let current = true;
    setFailed(false);
    openTryConversation(client, agent, workspaceId).then(
      (conversationId) => {
        if (!current) return;
        opened.current = { agent, conversationId };
        showTry(agent, conversationId);
      },
      () => {
        if (current) setFailed(true);
      }
    );
    return () => {
      current = false;
    };
  }, [agent, attempt, client, opening, showTry, workspaceId]);

  // The draft the page read is gone: its Try conversations went with it.
  const draftRevision = target?.draftRevision;
  const draftBefore = useRef<{ agent: string | undefined; revision: number | null | undefined }>({
    agent,
    revision: draftRevision
  });
  useEffect(() => {
    const before = draftBefore.current;
    draftBefore.current = { agent, revision: draftRevision };
    if (agent === undefined || before.agent !== agent) return;
    if (!tryConversationGone(before.revision, draftRevision)) return;
    opened.current = undefined;
    if (trying) showTry(agent, undefined);
  }, [agent, draftRevision, showTry, trying]);

  const select = useCallback(
    (next: DockTab) => {
      if (next === "build") {
        showBuild();
        return;
      }
      if (agent === undefined) return;
      const known = opened.current?.agent === agent ? opened.current.conversationId : undefined;
      showTry(agent, known);
    },
    [agent, showBuild, showTry]
  );
  const open = useCallback(() => select("try"), [select]);
  const retry = useCallback(() => setAttempt((count) => count + 1), []);

  const host = useMemo<AgentTryHost>(
    () => ({ offer, open: dock.open ? undefined : open }),
    [dock.open, open]
  );
  const title = target?.title;
  const view = useMemo<AgentTryView | undefined>(
    () =>
      title === undefined
        ? undefined
        : { tab: trying ? "try" : "build", select, title, runs: tryRunsOf(draftRevision) },
    [draftRevision, select, title, trying]
  );
  const pane = useMemo<AgentTryPaneState | undefined>(
    () => (trying && agent !== undefined ? { agent, opening, failed, retry } : undefined),
    [agent, failed, opening, retry, trying]
  );
  return { host, view, pane };
}
