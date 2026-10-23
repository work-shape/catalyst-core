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
  /** The draft revision the publish makes live, or the first version it offers. */
  revision: z.number().int().positive(),
  /** Null for the publish of a first version that has no draft: version 1 as it is stored. */
  draftRevision: z.number().int().positive().nullable(),
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
  revision: number,
  firstVersion = false
): AgentPublishSubject {
  return {
    kind: "agent",
    name: asset.name,
    title,
    assetId: asset.id,
    revision,
    draftRevision: firstVersion ? null : revision,
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
  // A first version is offered as it is stored only while no draft stands beside it.
  if (subject.draftRevision === null) return draft ? "draft_moved" : undefined;
  if (draft?.revision !== subject.draftRevision) return "draft_moved";
  return undefined;
}

/**
 * Whether a publish of this agent is its first and offers it in the workspace that owns it: a
 * workspace's agent that was never published (its live revision is the one its creation wrote)
 * and is offered nowhere. A later publish never widens or restores where it is offered: that
 * stays an instance admin's step.
 */
function offersOnPublish(
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

type OfferingOptions = {
  clientInstanceId: ClientInstanceId;
  configAssets: { store: Pick<ConfigAssetStore, "listAgentAvailability"> };
  stores: {
    workspaces: Pick<PlatformStores["workspaces"], "getWorkspace">;
    agentProposals: Pick<AgentProposalStore, "get">;
  };
};

/**
 * The shared workspace a publish of this agent offers it in: the one that owns it, where the
 * publish is its first and it is offered nowhere. Nothing for an instance's own agent, a later
 * publish or one owned by a Personal Workspace, which no availability names alone.
 */
export async function firstOffering(
  options: Omit<OfferingOptions, "stores"> & {
    stores: Pick<OfferingOptions["stores"], "workspaces">;
  },
  asset: Pick<ConfigAssetRecord, "name" | "status" | "scope" | "revision"> | undefined
): Promise<string | undefined> {
  if (!asset || asset.status !== "active") return undefined;
  const availability = await options.configAssets.store.listAgentAvailability({
    clientInstanceId: options.clientInstanceId,
    agentName: asset.name
  });
  const workspaceId = offersOnPublish(asset, availability.get(asset.name));
  if (workspaceId === undefined) return undefined;
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    asCollaborationWorkspaceId(workspaceId)
  );
  return workspace?.kind === "shared" ? workspaceId : undefined;
}

/**
 * The workspace a publish of version 1 without a draft offers the agent in (access check 11):
 * an agent its workspace's approvers have not yet offered, published as it was made. Nothing
 * where the call names another revision, where a draft stands beside it, or where it is no
 * first publish.
 */
export async function firstVersionOffering(
  options: OfferingOptions,
  asset: Pick<ConfigAssetRecord, "id" | "name" | "status" | "scope" | "revision"> | undefined,
  revision: number
): Promise<string | undefined> {
  if (!asset || revision !== asset.revision) return undefined;
  const draft = await options.stores.agentProposals.get({
    clientInstanceId: options.clientInstanceId,
    agentId: asset.id
  });
  return draft ? undefined : firstOffering(options, asset);
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
  const first = subject.draftRevision === null;
  // A first version has no live revision to compare with: it is reviewed alone.
  const head = {
    kind: subject.kind,
    name: subject.name,
    title: subject.title,
    revision: subject.revision,
    ...(first ? {} : { liveRevision: subject.liveRevision })
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
  // The draft as it was asked for, or the first version as it is stored, where it is still
  // that one; otherwise nothing of it.
  const next = first
    ? moved
      ? undefined
      : live
    : draft?.revision === subject.draftRevision
      ? configOf(draft.config)
      : undefined;
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
      ...(next ? agentDifference(first ? {} : live, next, first) : {})
    },
    ...(moved ? { stale: moved } : {})
  };
}

/**
 * The fields of the draft that differ from the live definition, and what they add. A first
 * version is compared with nothing, so it names no fields, and its lists are all it has.
 */
function agentDifference(live: JsonObject, next: JsonObject, first: boolean): JsonObject {
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
    ...(first ? {} : { fields }),
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
