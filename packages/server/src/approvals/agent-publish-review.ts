import {
  agentRunInstructions,
  asCollaborationWorkspaceId,
  isJsonObject,
  type AccessResource,
  type ActorAccess,
  type AgentProposalStore,
  type ApprovalPreviewViewer,
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

/** What an agent's publish was checked as: a draft revision, or the first version as stored. */
export interface AgentPublishChecked {
  revision: number;
  firstVersion: boolean;
  /**
   * What a held publish was approved as, kept beside its input: the call the approval resumes
   * publishes that, or nothing, whatever its guardrails read when it runs.
   */
  approvedFirstVersion?: boolean;
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

type OfferingOptions = {
  clientInstanceId: ClientInstanceId;
  configAssets: { store: Pick<ConfigAssetStore, "agentAwaitsFirstPublish"> };
  stores: {
    workspaces: Pick<PlatformStores["workspaces"], "getWorkspace">;
    agentProposals: Pick<AgentProposalStore, "get">;
  };
};

/**
 * The shared workspace a publish of this agent offers it in: the one that owns it, where the
 * agent was made hidden until its first publish and nobody has set where it is offered since.
 * Nothing for an instance's own agent, one an admin or its maker placed, or one owned by a
 * Personal Workspace, which no availability names alone. A publish never widens or restores
 * where an agent is offered otherwise: that stays an instance admin's step.
 */
export async function firstOffering(
  options: Omit<OfferingOptions, "stores"> & {
    stores: Pick<OfferingOptions["stores"], "workspaces">;
  },
  asset: Pick<ConfigAssetRecord, "name" | "status" | "scope"> | undefined
): Promise<string | undefined> {
  if (!asset || asset.status !== "active" || asset.scope.kind !== "workspace") return undefined;
  const { workspaceId } = asset.scope;
  if (
    !(await options.configAssets.store.agentAwaitsFirstPublish({
      clientInstanceId: options.clientInstanceId,
      agentName: asset.name
    }))
  )
    return undefined;
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
  store: Pick<ConfigAssetStore, "getConfigAsset" | "agentAwaitsFirstPublish">;
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
  "useModelFallback",
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
 * and the workspace it is offered in. The instructions only to a viewer who may read the agent.
 * A row of a list names it as it was filed and reads nothing.
 */
export async function agentPublishReview(
  options: AgentPublishReviewOptions,
  subject: AgentPublishSubject,
  inList: boolean,
  viewer?: Pick<ApprovalPreviewViewer, "access">
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
  const offers =
    asset !== undefined &&
    !moved &&
    asset.scope.kind === "workspace" &&
    workspace?.kind === "shared" &&
    (await options.store.agentAwaitsFirstPublish({ clientInstanceId, agentName: asset.name }));
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
      offers,
      ...(next ? agentDifference(first ? {} : live, next, first, readsAgent(subject, viewer)) : {})
    },
    ...(moved ? { stale: moved } : {})
  };
}

/**
 * Whether who reads the review may read the agent's instructions: a holder of `agent.read` or
 * `agent.write` on it. `agent.approve` alone decides the publish without reading them, and a
 * review read for nobody in particular shows them to nobody.
 */
function readsAgent(
  subject: AgentPublishSubject,
  viewer: Pick<ApprovalPreviewViewer, "access"> | undefined
): boolean {
  if (!viewer) return false;
  const resource = agentPublishResource(subject);
  return ["agent.read", "agent.write"].some(
    (action) => viewer.access.authorize(action, resource).allowed
  );
}

/**
 * The fields of the draft that differ from the live definition, and what they add. A first
 * version is compared with nothing, so it names no fields, and its lists are all it has.
 */
function agentDifference(
  liveConfig: JsonObject,
  nextConfig: JsonObject,
  first: boolean,
  readable: boolean
): JsonObject {
  // The instructions as the agent runs with them: what the instance added to a shipped
  // agent's is part of them.
  const live = withRunInstructions(liveConfig);
  const next = withRunInstructions(nextConfig);
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
    ...(instructions !== undefined && instructions !== liveInstructions && !readable
      ? { instructionsWithheld: true }
      : {}),
    ...(instructions !== undefined && instructions !== liveInstructions && readable
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

/** The definition with `instructions` as the agent runs with them. */
function withRunInstructions(config: JsonObject): JsonObject {
  const { instructions, additionalInstructions } = config;
  if (typeof instructions !== "string") return config;
  return {
    ...config,
    instructions: agentRunInstructions({
      instructions,
      ...(typeof additionalInstructions === "string" ? { additionalInstructions } : {})
    })
  };
}
