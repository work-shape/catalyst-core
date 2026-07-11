import type { AuditActor } from "./audit";
import type { AgentConfig, SkillConfig } from "./config";
import type { ClientInstanceId } from "./ids";
import type { JsonObject } from "./json";

export type ConfigAssetKind = "agent" | "skill";

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
  getConfigAssetState(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<ConfigAssetState>;
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
    actor?: AuditActor;
    mutations: ConfigAssetMutation[];
  }): Promise<{ version: number }>;
}
