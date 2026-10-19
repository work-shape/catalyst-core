import type { AgentDraft, ApiClient } from "@work-shape/catalyst-api-client";
import { apiErrorCode } from "../../shared/workspace-utils";
import { operationTitle } from "./connection-approval-model";
import { instanceSentence } from "./build-refusals";

// "Einem Agenten geben" (CS-5d; manager's ruling of 2026-10-19): the approved tools of a
// Connection go to one agent the person picks, as one published revision of that agent, after a
// confirmation that names the agent and the tools. Only an agent the person may publish is
// offered. An agent with an unpublished draft by somebody else is refused and never written:
// that draft is theirs. Where the person has a draft of their own, the tools are added to it,
// and it is published only where the person confirms publishing the whole draft.
//
// It is made of the operations the agent page uses, each with its own right, policy and audit:
// the agent's draft is saved with `assets.put` and published with `assets.publish`. A run of an
// agent reads the agent as it is published at the run's start, so the tools are the agent's from
// the next message on, in the same conversation as in any other.

/** The field of an agent's definition that holds its tools. */
const TOOL_NAMES = "toolNames";

/** How many agents one read lists at most, and how many pages it reads. */
const AGENTS_PAGE = 100;
const AGENTS_PAGES = 10;

/** One tool of the Connection as the confirmation names it. */
export interface GiveTool {
  toolName: string;
  /** The operation in words. */
  title: string;
}

/** The Connection's tools agents may call, as the instance answers them now. */
export interface GiveConnection {
  title: string;
  tools: GiveTool[];
}

/** An agent the person may change and publish, as the picker offers it. */
export interface GiveAgent {
  name: string;
  title: string;
  description?: string;
  /** Who wrote its unpublished draft, where it has one. */
  draft?: { userId?: string; authorName?: string };
}

/** What the agent is now, as the give is decided on it. */
interface AgentNow {
  title: string;
  liveRevision: number;
  /** The definition the tools are added to: the reader's own draft where there is one. */
  config: Record<string, unknown>;
  /** The reader's own draft, by its revision. */
  ownDraft?: { revision: number };
}

/** What the person is asked once they picked an agent. */
export type GivePlan =
  /** The tools that are added, on the agent as it stands. */
  | { status: "ready"; agent: string; now: AgentNow; tools: GiveTool[] }
  /** The agent, or the reader's own draft of it, has every tool already. */
  | { status: "held"; agent: string; title: string; inDraft: boolean }
  /** Somebody else's draft is open: nothing is written. */
  | { status: "other_draft"; agent: string; title: string; author?: string }
  /**
   * The reader's own draft is behind the published agent: nothing is written. A save would base
   * it on the published version unseen, and its publish would undo what was published since.
   */
  | { status: "stale_draft"; agent: string; title: string }
  | { status: "failed"; message?: string };

/** What the give did. */
export type GiveOutcome =
  /** The agent is published with the tools. */
  | { status: "published" }
  /** The tools are in the reader's own draft, which is not published. */
  | { status: "drafted" }
  /** The publish waits for an approval in the Inbox. The draft holds the tools. */
  | { status: "waits" }
  | { status: "other_draft"; author?: string }
  | { status: "failed"; message?: string };

/** The reads and writes a give is made of. A test hands answers of its own. */
export interface ConnectionGiveSource {
  /** The Connection's tools agents may call, or nothing where it has none the reader may read. */
  connection(name: string): Promise<GiveConnection | undefined>;
  /** The instance's agents the reader may change and publish. */
  agents(): Promise<GiveAgent[]>;
  /** The agent as it is published. */
  readAgent(name: string): Promise<{ revision: number; config: Record<string, unknown> }>;
  /** The agent's one unpublished draft, or `null` where it has none. */
  readDraft(name: string): Promise<AgentDraft | null>;
  /**
   * Saves the agent's draft over what the reader read, and answers the draft's revision, or
   * `waits` where the save waits for an approval first.
   */
  saveDraft(
    name: string,
    config: Record<string, unknown>,
    expected: { liveRevision: number; draftRevision: number | null }
  ): Promise<number | "waits">;
  /** Publishes the draft revision. `waits` where somebody approves it first. */
  publish(name: string, revision: number): Promise<"done" | "waits">;
  /** Discards the draft revision the give wrote, after its publish was refused. */
  discard(name: string, revision: number): Promise<void>;
}

/** The tool names of a definition, in its order. */
function toolNamesOf(config: Record<string, unknown>): string[] {
  const names = config[TOOL_NAMES];
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
}

/** The definition with the tools added after those it holds, each once. */
export function withGivenTools(
  config: Record<string, unknown>,
  toolNames: readonly string[]
): Record<string, unknown> {
  return { ...config, [TOOL_NAMES]: [...new Set([...toolNamesOf(config), ...toolNames])] };
}

/**
 * Reads the agent and its draft and decides what the person is asked: the tools that would be
 * added, or why nothing is asked. A draft whose author is not the reader is somebody else's,
 * also one a release wrote.
 */
export async function planGive(
  source: ConnectionGiveSource,
  input: { agent: GiveAgent; tools: readonly GiveTool[]; viewerId: string }
): Promise<GivePlan> {
  const { name: agent, title } = input.agent;
  let live: Awaited<ReturnType<ConnectionGiveSource["readAgent"]>>;
  let draft: AgentDraft | null;
  try {
    [live, draft] = await Promise.all([source.readAgent(agent), source.readDraft(agent)]);
  } catch (error) {
    return { status: "failed", ...messageOf(error) };
  }
  if (draft && draft.author.userId !== input.viewerId) {
    return { status: "other_draft", agent, title, ...authorOf(draft) };
  }
  if (draft && (draft.stale || draft.baseRevision !== live.revision)) {
    return { status: "stale_draft", agent, title };
  }
  const config = draft ? draft.config : live.config;
  const held = toolNamesOf(config);
  const tools = input.tools.filter((tool) => !held.includes(tool.toolName));
  if (tools.length === 0) {
    return { status: "held", agent, title, inDraft: draft !== null };
  }
  return {
    status: "ready",
    agent,
    tools,
    now: {
      title,
      liveRevision: live.revision,
      config,
      ...(draft ? { ownDraft: { revision: draft.revision } } : {})
    }
  };
}

/**
 * Gives the tools the plan names: one save of the agent's draft with them added, then its
 * publish. With a draft of the reader's own, the publish follows only with `publishDraft`. A
 * draft the give wrote itself and could not publish is discarded again, so the agent is left as
 * it was; one the publish waits for stays, for the approval to publish.
 */
export async function giveTools(
  source: ConnectionGiveSource,
  plan: Extract<GivePlan, { status: "ready" }>,
  options: { publishDraft: boolean; viewerId: string }
): Promise<GiveOutcome> {
  const { agent, now } = plan;
  const config = withGivenTools(
    now.config,
    plan.tools.map((tool) => tool.toolName)
  );
  let revision: number | "waits";
  try {
    revision = await source.saveDraft(agent, config, {
      liveRevision: now.liveRevision,
      draftRevision: now.ownDraft?.revision ?? null
    });
  } catch (error) {
    // A draft written meanwhile refuses the save. Where it is somebody else's, they are named.
    const draft = isConflict(error) ? await source.readDraft(agent).catch(() => null) : null;
    if (draft && draft.author.userId !== options.viewerId) {
      return { status: "other_draft", ...authorOf(draft) };
    }
    return { status: "failed", ...messageOf(error) };
  }
  if (revision === "waits") return { status: "waits" };
  if (now.ownDraft && !options.publishDraft) return { status: "drafted" };
  try {
    return (await source.publish(agent, revision)) === "done"
      ? { status: "published" }
      : { status: "waits" };
  } catch (error) {
    if (!now.ownDraft) await source.discard(agent, revision).catch(() => undefined);
    return { status: "failed", ...messageOf(error) };
  }
}

function isConflict(error: unknown): boolean {
  const code = apiErrorCode(error);
  return code === "REVISION_CONFLICT" || code === "CONFLICT";
}

function authorOf(draft: AgentDraft): { author?: string } {
  const author = draft.author.name ?? draft.author.displayLabel;
  return author === undefined ? {} : { author };
}

function messageOf(error: unknown): { message?: string } {
  const message = instanceSentence(error);
  return message === undefined ? {} : { message };
}

/** The give on the instance, with the reader's own rights. */
export function connectionGiveSource(client: ApiClient): ConnectionGiveSource {
  return {
    async connection(name) {
      const { connections } = await client.connections.list_tools();
      const found = connections.find((connection) => connection.name === name);
      if (!found || found.tools.length === 0) return undefined;
      return {
        title: found.title.trim() || found.name,
        tools: found.tools.map((tool) => ({
          toolName: tool.toolName,
          title: operationTitle(tool.operation)
        }))
      };
    },
    async agents() {
      const agents: GiveAgent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < AGENTS_PAGES; page += 1) {
        const read = await client.assets.list({
          params: { kind: "agent" },
          query: { limit: AGENTS_PAGE, ...(cursor === undefined ? {} : { cursor }) }
        });
        for (const row of read.items) {
          // The instance's own agents, where the reader may write and publish: a workspace's
          // agent names the Connections of its own workspace.
          if (row.scope.kind !== "instance") continue;
          if (!row.allowed?.includes("write") || !row.allowed.includes("publish")) continue;
          const author = row.agentDraft?.author;
          agents.push({
            name: row.name,
            title: row.title.trim() || row.name,
            ...(row.description ? { description: row.description } : {}),
            ...(author
              ? {
                  draft: {
                    ...(author.userId === undefined ? {} : { userId: author.userId }),
                    ...(author.displayLabel === undefined
                      ? {}
                      : { authorName: author.displayLabel })
                  }
                }
              : {})
          });
        }
        cursor = read.nextCursor;
        if (cursor === undefined) break;
      }
      return agents;
    },
    async readAgent(name) {
      const asset = await client.assets.get({ params: { kind: "agent", name }, query: {} });
      return { revision: asset.revision, config: asset.config };
    },
    async readDraft(name) {
      try {
        return (await client.agents.draft.get({ params: { name }, query: {} })).draft;
      } catch (error) {
        // The instance tells the draft to a holder of the write right alone.
        if (apiErrorCode(error) === "NOT_FOUND") return null;
        throw error;
      }
    },
    async saveDraft(name, config, expected) {
      const written = await client.assets.put({
        params: { kind: "agent", name },
        body: {
          config,
          expectedRevision: expected.liveRevision,
          expectedDraftRevision: expected.draftRevision
        }
      });
      if (written.status !== "done") return "waits";
      return written.output.draftRevision ?? written.output.revision;
    },
    async publish(name, revision) {
      const outcome = await client.assets.publish({
        params: { kind: "agent", name },
        body: { revision }
      });
      return outcome.status === "done" ? "done" : "waits";
    },
    async discard(name, revision) {
      await client.agents.draft.discard({
        params: { name },
        body: { expectedRevision: revision }
      });
    }
  };
}
