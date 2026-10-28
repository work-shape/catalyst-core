import {
  isMountableSkillName,
  type ConfigAssetSource,
  type RuntimeAssetSnapshot,
  type ConversationOfferSource,
  type ToolExecutionContext,
  type WorkspaceCommandSkillMount
} from "@work-shape/catalyst-core";
import { createSkillSourceVersion } from "./skill-source-version";

/**
 * The skills this run may read or use, including its frozen Try draft and conversation offer,
 * which holds the person's own skills where the run is theirs (SCOPE-MYCHATS).
 */
export async function runSkillNames(options: RunSkillOptions): Promise<Set<string>> {
  return (await runSkillOffer(options)).names;
}

interface RunSkillOptions {
  context: ToolExecutionContext;
  assets: RuntimeAssetSnapshot;
  conversationOffer?: ConversationOfferSource;
}

/**
 * `runSkillNames`, and which of them the run reads only as its person's own (SCOPE-MYCHATS):
 * a read of one of those carries that person's data into the chat.
 */
export async function runSkillOffer(
  options: RunSkillOptions
): Promise<{ names: Set<string>; personal: Set<string> }> {
  const { context, assets } = options;
  const agentName = context.toolRequest?.agentName;
  if (!agentName) return { names: new Set(), personal: new Set() };
  const draft = context.agentPreview?.config;
  const preview = draft?.name === agentName ? draft : undefined;
  const agent = preview ?? assets.agents.find((candidate) => candidate.name === agentName);
  const conversationId = context.toolRequest?.conversationId;
  // Try turns use only their frozen draft, with no conversation offer.
  const offer =
    conversationId && !preview
      ? await options.conversationOffer?.offerOf({
          clientInstanceId: context.clientInstanceId,
          conversationId,
          agentToolNames: agent?.toolNames ?? [],
          user: context.user,
          ...(context.toolRequest?.agentRunId ? { runId: context.toolRequest.agentRunId } : {})
        })
      : undefined;
  const shared = new Set([...(agent?.skillNames ?? []), ...(offer?.skillNames ?? [])]);
  const personal = new Set((offer?.personalSkillNames ?? []).filter((name) => !shared.has(name)));
  return { names: new Set([...shared, ...personal]), personal };
}

/** Where a workspace command finds the skills of its run. */
export interface WorkspaceSkillSource {
  assetSource: ConfigAssetSource;
  /** Which skills the platform ships to a conversation, beside those its agent lists. */
  conversationOffer?: ConversationOfferSource;
}

/**
 * The skills a workspace command of this run mounts, each at the revision that is live now:
 * exactly those `read_skill` lets the run read (`runSkillNames`, of skills that exist), in the
 * order of their names. None for a call outside an agent run.
 */
export async function runSkillMounts(
  source: WorkspaceSkillSource,
  context: ToolExecutionContext
): Promise<WorkspaceCommandSkillMount[]> {
  if (!context.toolRequest?.agentRunId || !context.toolRequest.agentName) return [];
  const assets = await source.assetSource.getSnapshot();
  const allowed = await runSkillNames({
    context,
    assets,
    conversationOffer: source.conversationOffer
  });
  const existing = new Set(assets.skills.map((skill) => skill.name));
  const mounts: WorkspaceCommandSkillMount[] = [];
  for (const name of [...allowed].filter((candidate) => existing.has(candidate)).sort()) {
    if (!isMountableSkillName(name)) continue;
    const live = await source.assetSource.getSkillRevision(name);
    if (!live || live.skill.name !== name) continue;
    mounts.push({
      name,
      revision: live.revision,
      sourceVersion: createSkillSourceVersion(live.skill)
    });
  }
  return mounts;
}
