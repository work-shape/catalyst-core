import type { AuditActor } from "./audit";
import type { AgentConfig, SkillConfig } from "./config";
import type { CollaborationWorkspaceKind } from "./collaboration-workspace";
import type { ClientInstanceId, CollaborationWorkspaceId } from "./ids";
import type { JsonObject } from "./json";

export type ConfigAssetKind = "agent" | "skill";

export type AgentAvailabilityMode = "all" | "selected";

/**
 * Where an agent may be used. Availability is an access rule: an agent without an availability
 * record is hidden everywhere.
 */
export interface AgentAvailability {
  mode: AgentAvailabilityMode;
  /** With `selected`: whether the agent is available in Personal Workspaces. */
  personalWorkspaces: boolean;
  /** With `selected`: the Shared Workspaces the agent is available in. */
  collaborationWorkspaceIds: CollaborationWorkspaceId[];
}

/**
 * Availability given to agents a mutation batch creates or revives.
 * `selected_when_replacing_selected` is the config push rule: a batch that also deletes a
 * `selected` agent is treated as a rename, so its new agents start hidden instead of `all`.
 */
export type InitialAgentAvailability = "all" | "selected" | "selected_when_replacing_selected";

export function resolveInitialAgentAvailabilityMode(
  initial: InitialAgentAvailability | undefined,
  deletesSelectedAgent: boolean
): AgentAvailabilityMode {
  if (initial === "selected_when_replacing_selected") {
    return deletesSelectedAgent ? "selected" : "all";
  }
  return initial ?? "all";
}

export function isAgentAvailableInWorkspace(
  availability: AgentAvailability | undefined,
  workspace: { kind: CollaborationWorkspaceKind; id?: CollaborationWorkspaceId }
): boolean {
  if (!availability) {
    return false;
  }
  if (availability.mode === "all") {
    return true;
  }
  return workspace.kind === "personal"
    ? availability.personalWorkspaces
    : workspace.id !== undefined && availability.collaborationWorkspaceIds.includes(workspace.id);
}

export interface RuntimeAssetSnapshot {
  version: number;
  defaultAgentName?: string;
  agents: AgentConfig[];
  skills: SkillConfig[];
}

export interface ConfigAssetSource {
  getSnapshot(): Promise<RuntimeAssetSnapshot>;
}

export interface ConfigAssetRecord {
  id: string;
  clientInstanceId: ClientInstanceId;
  kind: ConfigAssetKind;
  name: string;
  status: "active" | "deleted";
  activeRevisionId: string;
  revision: number;
  config: JsonObject | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigAssetRevisionRecord {
  id: string;
  assetId: string;
  clientInstanceId: ClientInstanceId;
  revision: number;
  operation: "create" | "update" | "delete" | "revert";
  config: JsonObject | null;
  actor: AuditActor | null;
  origin?: { kind: "approval_request"; requestId: string; summary: string };
  globalVersion: number;
  createdAt: string;
}

export interface ConfigAssetState {
  version: number;
  defaultAgentName?: string;
}

export type ConfigAssetMutation =
  | {
      type: "upsert";
      kind: ConfigAssetKind;
      name: string;
      config: JsonObject;
      operation?: "revert";
    }
  | { type: "delete"; kind: ConfigAssetKind; name: string }
  | { type: "setDefaultAgent"; agentName: string | undefined };

export interface ConfigAssetStore {
  getConfigAssetState(input: { clientInstanceId: ClientInstanceId }): Promise<ConfigAssetState>;
  listActiveConfigAssets(input: {
    clientInstanceId: ClientInstanceId;
    kind?: ConfigAssetKind;
  }): Promise<ConfigAssetRecord[]>;
  getConfigAsset(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
  }): Promise<ConfigAssetRecord | undefined>;
  listConfigAssetRevisions(input: {
    clientInstanceId: ClientInstanceId;
    kind: ConfigAssetKind;
    name: string;
  }): Promise<ConfigAssetRevisionRecord[]>;
  applyConfigAssetMutations(input: {
    clientInstanceId: ClientInstanceId;
    baseVersion?: number;
    baseRevisions?: Record<string, number | null>;
    baseDefaultAgentName?: string | null;
    actor?: AuditActor;
    origin?: ConfigAssetRevisionRecord["origin"];
    /** Defaults to `all`. */
    initialAgentAvailability?: InitialAgentAvailability;
    mutations: ConfigAssetMutation[];
  }): Promise<{ version: number }>;
  /** Availability of every active agent that has a record, keyed by agent name. */
  listAgentAvailability(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<Map<string, AgentAvailability>>;
  /** Rejects hiding the instance default agent, which must stay `all`. */
  setAgentAvailability(input: {
    clientInstanceId: ClientInstanceId;
    agentName: string;
    availability: AgentAvailability;
  }): Promise<AgentAvailability>;
}
