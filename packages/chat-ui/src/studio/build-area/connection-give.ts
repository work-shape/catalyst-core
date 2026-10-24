import type { ApiClient } from "@work-shape/catalyst-api-client";
import { apiErrorCode } from "../../shared/workspace-utils";
import { operationTitle } from "./connection-approval-model";
import { instanceSentence } from "./build-refusals";

// "Einem Agenten geben" (CS-5d; ruling of 2026-10-24): the approved tools of a Connection go to
// one agent the person picks, after a confirmation that names the agent and the tools. Only an
// agent the person may change and publish is offered. The give is one call, `agents.give_tools`:
// the agent gets a new live revision of what is published plus the tools, and a pending draft,
// whoever wrote it, keeps its content and its author and gets the same tools. A draft is never
// published by the give. A run of an agent reads the agent as it is published at the run's
// start, so the tools are the agent's from the next message on.

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

/** The published agent the give is decided on: what the instance fences the give with. */
interface AgentNow {
  title: string;
  agentId: string;
  liveRevision: number;
}

/** What the person is asked once they picked an agent. */
export type GivePlan =
  /** The tools that are added to the published agent. */
  | { status: "ready"; agent: string; now: AgentNow; tools: GiveTool[]; draft: boolean }
  /** The published agent has every tool already. */
  | { status: "held"; agent: string; title: string }
  | { status: "failed"; message?: string };

/** What the give did. */
export type GiveOutcome =
  /** The agent is live with the tools. */
  | { status: "published" }
  /** The give waits for an approval in the Inbox. Nothing is changed yet. */
  | { status: "waits" }
  /** The published agent changed since it was read: nothing is changed. */
  | { status: "changed" }
  | { status: "failed"; message?: string };

/** The reads and the write a give is made of. A test hands answers of its own. */
export interface ConnectionGiveSource {
  /** The Connection's tools agents may call, or nothing where it has none the reader may read. */
  connection(name: string): Promise<GiveConnection | undefined>;
  /** The instance's agents the reader may change and publish. */
  agents(): Promise<GiveAgent[]>;
  /** The agent as it is published. */
  readAgent(
    name: string
  ): Promise<{ id: string; revision: number; config: Record<string, unknown> }>;
  /** Gives the tools to the published agent the reader read. `waits` where somebody approves it first. */
  give(
    name: string,
    input: { agentId: string; toolNames: string[]; expectedLiveRevision: number }
  ): Promise<"done" | "waits">;
}

/** The tool names of a definition, in its order. */
function toolNamesOf(config: Record<string, unknown>): string[] {
  const names = config[TOOL_NAMES];
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * Reads the published agent and decides what the person is asked: the tools that would be
 * added, or why nothing is asked. A draft, anybody's, changes nothing of the question: it keeps
 * its content and gets the tools too.
 */
export async function planGive(
  source: ConnectionGiveSource,
  input: { agent: GiveAgent; tools: readonly GiveTool[] }
): Promise<GivePlan> {
  const { name: agent, title } = input.agent;
  let live: Awaited<ReturnType<ConnectionGiveSource["readAgent"]>>;
  try {
    live = await source.readAgent(agent);
  } catch (error) {
    return { status: "failed", ...messageOf(error) };
  }
  const held = toolNamesOf(live.config);
  const tools = input.tools.filter((tool) => !held.includes(tool.toolName));
  if (tools.length === 0) return { status: "held", agent, title };
  return {
    status: "ready",
    agent,
    tools,
    draft: input.agent.draft !== undefined,
    now: { title, agentId: live.id, liveRevision: live.revision }
  };
}

/** Gives the tools the plan names, over the published agent the plan read. */
export async function giveTools(
  source: ConnectionGiveSource,
  plan: Extract<GivePlan, { status: "ready" }>
): Promise<GiveOutcome> {
  try {
    const done = await source.give(plan.agent, {
      agentId: plan.now.agentId,
      toolNames: plan.tools.map((tool) => tool.toolName),
      expectedLiveRevision: plan.now.liveRevision
    });
    return done === "done" ? { status: "published" } : { status: "waits" };
  } catch (error) {
    const code = apiErrorCode(error);
    if (code === "REVISION_CONFLICT" || code === "CONFLICT") return { status: "changed" };
    return { status: "failed", ...messageOf(error) };
  }
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
      return { id: asset.id, revision: asset.revision, config: asset.config };
    },
    async give(name, input) {
      const outcome = await client.agents.give_tools({ params: { name }, body: input });
      return outcome.status === "done" ? "done" : "waits";
    }
  };
}
