import {
  asCollaborationWorkspaceId,
  isJsonObject,
  type AccessResource,
  type ActorAccess,
  type AgentProposalStore,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type JsonObject,
  type JsonValue,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { z } from "zod";

// The held publish of an agent a workspace owns (WS-PUB-1b): an `agent_publish` request that
// the holders of `agent.approve` on that agent decide. An agent's draft lives beside its live
// revision in the draft store, so the request freezes the draft revision it publishes and the
// live revision then, and its review compares the draft with the live definition: the fields
// that differ, the tools and model bindings it adds, the skills it names and the workspace it
// is offered in. Spec: access-and-permissions.md, Drafts and publishing of agents.

export const AGENT_PUBLISH_APPROVAL_KIND = "agent_publish";

/** What an agent's held publish is about, frozen when it is filed. */
export const agentPublishSubjectSchema = z.object({
  kind: z.literal("agent"),
  name: z.string().min(1),
  title: z.string().min(1),
  assetId: z.string().min(1),
  /** The draft revision the publish makes live. */
  revision: z.number().int().positive(),
  draftRevision: z.number().int().positive(),
  /** The live revision the draft was written on and the publish replaces. */
  liveRevision: z.number().int().positive(),
  /** The workspace that owns the agent; null for the instance's own. */
  workspaceId: z.string().min(1).nullable()
});

export type AgentPublishSubject = z.infer<typeof agentPublishSubjectSchema>;

/** The resource the right to decide a held agent publish is asked on: the agent, with its owner. */
export function agentPublishResource(subject: AgentPublishSubject): AccessResource {
  return {
    kind: "agent",
    name: subject.name,
    assetId: subject.assetId,
    ...(subject.workspaceId === null ? {} : { workspaceId: subject.workspaceId })
  };
}

/** The subject of the publish of one agent's draft revision, as it stands now. */
export function agentPublishSubject(
  asset: ConfigAssetRecord,
  title: string,
  revision: number
): AgentPublishSubject {
  return {
    kind: "agent",
    name: asset.name,
    title,
    assetId: asset.id,
    revision,
    draftRevision: revision,
    liveRevision: asset.revision,
    workspaceId: asset.scope.kind === "workspace" ? asset.scope.workspaceId : null
  };
}

/** Why a held publish can no longer be approved, an App's, a Workflow's or an agent's. */
export type PublishMoved = "gone" | "draft_moved" | "live_moved";

/**
 * Why a held agent publish can no longer be approved: the agent is gone, its live revision
 * moved, or its draft is another than the one asked for. The publish itself checks both
 * revisions again under its lock.
 */
export async function agentPublishMoved(
  clientInstanceId: ClientInstanceId,
  subject: AgentPublishSubject,
  store: Pick<ConfigAssetStore, "getConfigAsset">,
  drafts: Pick<AgentProposalStore, "get">
): Promise<PublishMoved | undefined> {
  const asset = await store.getConfigAsset({ clientInstanceId, kind: "agent", name: subject.name });
  if (!asset || asset.id !== subject.assetId || asset.status !== "active") return "gone";
  if (asset.revision !== subject.liveRevision) return "live_moved";
  const draft = await drafts.get({ clientInstanceId, agentId: asset.id });
  if (draft?.revision !== subject.draftRevision) return "draft_moved";
  return undefined;
}

/**
 * Whether a publish of this agent is its first and offers it in the workspace that owns it: a
 * workspace's agent that was never published (its live revision is the one its creation wrote)
 * and is offered nowhere. A later publish never widens or restores where it is offered: that
 * stays an instance admin's step.
 */
export function offersOnPublish(
  asset: Pick<ConfigAssetRecord, "scope" | "revision">,
  availability:
    | { mode: string; personalWorkspaces: boolean; collaborationWorkspaceIds: readonly string[] }
    | undefined
): string | undefined {
  if (asset.scope.kind !== "workspace" || asset.revision !== 1) return undefined;
  const nowhere =
    availability === undefined ||
    (availability.mode === "selected" &&
      !availability.personalWorkspaces &&
      availability.collaborationWorkspaceIds.length === 0);
  return nowhere ? asset.scope.workspaceId : undefined;
}

export interface AgentPublishReviewOptions {
  clientInstanceId: ClientInstanceId;
  store: Pick<ConfigAssetStore, "getConfigAsset" | "listAgentAvailability">;
  drafts: Pick<AgentProposalStore, "get">;
  workspaces?: Pick<PlatformStores["workspaces"], "getWorkspace">;
}

/** The fields of an agent the review compares, in the order the agent page shows them. */
const REVIEWED_FIELDS = [
  "displayName",
  "description",
  "instructions",
  "modelBindingId",
  "userSelectableModelBindingIds",
  "reasoningEffort",
  "fastMode",
  "maxSteps",
  "toolNames",
  "skillNames",
  "knowledgeBases",
  "subagentNames",
  "welcomeMessage",
  "welcomeSubtitle",
  "initialPrompts"
] as const;

/**
 * What the person who decides an agent's held publish reads: the draft revision and the live one
 * it replaces, the fields that differ, the tools and model bindings it adds, the skills it names
 * and the workspace it is offered in. A row of a list names it as it was filed and reads nothing.
 */
export async function agentPublishReview(
  options: AgentPublishReviewOptions,
  subject: AgentPublishSubject,
  inList: boolean
): Promise<JsonObject> {
  const head = {
    kind: subject.kind,
    name: subject.name,
    title: subject.title,
    revision: subject.revision,
    liveRevision: subject.liveRevision
  };
  if (inList) return head;
  const { clientInstanceId } = options;
  const moved = await agentPublishMoved(clientInstanceId, subject, options.store, options.drafts);
  const asset = await options.store.getConfigAsset({
    clientInstanceId,
    kind: "agent",
    name: subject.name
  });
  const draft =
    asset && asset.id === subject.assetId
      ? await options.drafts.get({ clientInstanceId, agentId: asset.id })
      : undefined;
  const live = configOf(asset?.config);
  // The draft as it was asked for, where it is still that one; otherwise nothing of it.
  const next = draft?.revision === subject.draftRevision ? configOf(draft.config) : undefined;
  const workspace =
    subject.workspaceId !== null && options.workspaces
      ? await options.workspaces.getWorkspace(
          clientInstanceId,
          asCollaborationWorkspaceId(subject.workspaceId)
        )
      : undefined;
  const availability =
    asset && !moved
      ? (
          await options.store.listAgentAvailability({ clientInstanceId, agentName: asset.name })
        ).get(asset.name)
      : undefined;
  const offers = asset && !moved ? offersOnPublish(asset, availability) : undefined;
  return {
    ...head,
    // The lists every publish review carries; an agent has no files, hosts or stores of its own.
    files: [],
    hostsAdded: [],
    connections: [],
    dataStores: [],
    agent: {
      ...(subject.workspaceId === null
        ? {}
        : {
            workspace: {
              id: subject.workspaceId,
              ...(workspace ? { name: workspace.name } : {})
            }
          }),
      offers: offers !== undefined,
      ...(next ? agentDifference(live, next) : {})
    },
    ...(moved ? { stale: moved } : {})
  };
}

/** The fields of the draft that differ from the live definition, and what they add. */
function agentDifference(live: JsonObject, next: JsonObject): JsonObject {
  const fields = REVIEWED_FIELDS.flatMap((field) => {
    const before = live[field];
    const after = next[field];
    if (sameValue(before, after)) return [];
    const change = isEmpty(before) ? "added" : isEmpty(after) ? "removed" : "changed";
    return [{ field, change }];
  });
  const tools = names(next.toolNames);
  const liveTools = names(live.toolNames);
  const bindings = modelBindings(next);
  const liveBindings = modelBindings(live);
  const instructions = typeof next.instructions === "string" ? next.instructions : undefined;
  const liveInstructions = typeof live.instructions === "string" ? live.instructions : undefined;
  return {
    fields,
    toolsAdded: tools.filter((tool) => !liveTools.includes(tool)),
    toolsRemoved: liveTools.filter((tool) => !tools.includes(tool)),
    modelBindingsAdded: bindings.filter((binding) => !liveBindings.includes(binding)),
    skills: names(next.skillNames),
    ...(instructions !== undefined && instructions !== liveInstructions
      ? {
          instructions: {
            after: instructions,
            ...(liveInstructions === undefined ? {} : { before: liveInstructions })
          }
        }
      : {})
  };
}

/**
 * The agents whose held publish this holder of `agent.approve` may decide where their right does
 * not cover every agent: those it is held on, by the agent's id as the request froze it.
 */
export async function agentPublishReviewableSubjects(
  options: Pick<AgentPublishReviewOptions, "clientInstanceId"> & {
    store: Pick<ConfigAssetStore, "listActiveConfigAssets">;
  },
  access: ActorAccess
): Promise<JsonObject[]> {
  const agents = await options.store.listActiveConfigAssets({
    clientInstanceId: options.clientInstanceId,
    kind: "agent"
  });
  return agents
    .filter(
      (agent) =>
        access.authorize("agent.approve", {
          kind: "agent",
          name: agent.name,
          assetId: agent.id,
          ...(agent.scope.kind === "workspace" ? { workspaceId: agent.scope.workspaceId } : {})
        }).allowed
    )
    .map((agent) => ({ assetId: agent.id }));
}

function configOf(config: JsonObject | null | undefined): JsonObject {
  return config && isJsonObject(config) ? config : {};
}

function names(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];
}

function modelBindings(config: JsonObject): string[] {
  const listed = names(config.userSelectableModelBindingIds);
  const own = typeof config.modelBindingId === "string" ? [config.modelBindingId] : [];
  return [...new Set([...own, ...listed])];
}

function isEmpty(value: JsonValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function sameValue(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
