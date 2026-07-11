import {
  AppError,
  createPlatformId,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type ConfigAssetStore
} from "./index";

export class InMemoryConfigAssetStore implements ConfigAssetStore {
  private states = new Map<string, ConfigAssetState>();
  private assets = new Map<string, ConfigAssetRecord>();
  private revisions = new Map<string, ConfigAssetRevisionRecord[]>();

  async getConfigAssetState(
    input: Parameters<ConfigAssetStore["getConfigAssetState"]>[0]
  ): Promise<ConfigAssetState> {
    return { ...(this.states.get(input.clientInstanceId) ?? { version: 0 }) };
  }

  async listActiveConfigAssets(
    input: Parameters<ConfigAssetStore["listActiveConfigAssets"]>[0]
  ): Promise<ConfigAssetRecord[]> {
    return [...this.assets.values()]
      .filter(
        (asset) =>
          asset.clientInstanceId === input.clientInstanceId &&
          asset.status === "active" &&
          (input.kind === undefined || asset.kind === input.kind)
      )
      .sort((left, right) =>
        `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
      )
      .map(cloneAsset);
  }

  async getConfigAsset(
    input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
  ): Promise<ConfigAssetRecord | undefined> {
    const asset = this.assets.get(createAssetKey(input));
    return asset ? cloneAsset(asset) : undefined;
  }

  async listConfigAssetRevisions(
    input: Parameters<ConfigAssetStore["listConfigAssetRevisions"]>[0]
  ): Promise<ConfigAssetRevisionRecord[]> {
    const asset = this.assets.get(createAssetKey(input));
    if (!asset) {
      return [];
    }
    return (this.revisions.get(asset.id) ?? []).map(cloneRevision);
  }

  async applyConfigAssetMutations(
    input: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]
  ): Promise<{ version: number }> {
    const currentState = this.states.get(input.clientInstanceId) ?? { version: 0 };
    if (input.baseVersion !== undefined && input.baseVersion !== currentState.version) {
      throw new AppError("CONFLICT", "Config version mismatch", {
        currentVersion: currentState.version,
        baseVersion: input.baseVersion
      });
    }

    const states = new Map(this.states);
    const assets = new Map(
      [...this.assets].map(([key, asset]) => [key, cloneAsset(asset)] as const)
    );
    const revisions = new Map(
      [...this.revisions].map(([assetId, records]) => [
        assetId,
        records.map(cloneRevision)
      ] as const)
    );
    const version = currentState.version + 1;
    let defaultAgentName = currentState.defaultAgentName;
    const now = new Date().toISOString();

    for (const mutation of input.mutations) {
      if (mutation.type === "setDefaultAgent") {
        defaultAgentName = mutation.agentName;
        continue;
      }
      const key = createAssetKey({ clientInstanceId: input.clientInstanceId, ...mutation });
      const existing = assets.get(key);
      if (mutation.type === "delete") {
        if (!existing || existing.status === "deleted") {
          continue;
        }
        const revision = appendRevision({
          revisions,
          asset: existing,
          operation: "delete",
          config: null,
          actor: input.actor,
          globalVersion: version,
          createdAt: now
        });
        assets.set(key, {
          ...existing,
          status: "deleted",
          activeRevisionId: revision.id,
          revision: revision.revision,
          config: null,
          updatedAt: now
        });
        continue;
      }

      const config = structuredClone(mutation.config);
      if (!existing) {
        const assetId = createPlatformId("cfga");
        const revisionId = createPlatformId("cfgr");
        const asset: ConfigAssetRecord = {
          id: assetId,
          clientInstanceId: input.clientInstanceId,
          kind: mutation.kind,
          name: mutation.name,
          status: "active",
          activeRevisionId: revisionId,
          revision: 1,
          config,
          createdAt: now,
          updatedAt: now
        };
        assets.set(key, asset);
        revisions.set(assetId, [
          {
            id: revisionId,
            assetId,
            clientInstanceId: input.clientInstanceId,
            revision: 1,
            operation: mutation.operation ?? "create",
            config: structuredClone(config),
            actor: input.actor ? structuredClone(input.actor) : null,
            globalVersion: version,
            createdAt: now
          }
        ]);
        continue;
      }

      const revision = appendRevision({
        revisions,
        asset: existing,
        operation:
          mutation.operation ?? (existing.status === "deleted" ? "create" : "update"),
        config,
        actor: input.actor,
        globalVersion: version,
        createdAt: now
      });
      assets.set(key, {
        ...existing,
        status: "active",
        activeRevisionId: revision.id,
        revision: revision.revision,
        config,
        updatedAt: now
      });
    }

    if (defaultAgentName !== undefined) {
      const defaultAgent = assets.get(
        createAssetKey({
          clientInstanceId: input.clientInstanceId,
          kind: "agent",
          name: defaultAgentName
        })
      );
      if (!defaultAgent || defaultAgent.status !== "active") {
        throw new AppError(
          "VALIDATION_FAILED",
          `Default agent '${defaultAgentName}' is not an active config asset`
        );
      }
    }

    states.set(input.clientInstanceId, {
      version,
      ...(defaultAgentName === undefined ? {} : { defaultAgentName })
    });
    this.states = states;
    this.assets = assets;
    this.revisions = revisions;
    return { version };
  }
}

function createAssetKey(input: {
  clientInstanceId: string;
  kind: string;
  name: string;
}): string {
  return JSON.stringify([input.clientInstanceId, input.kind, input.name]);
}

function appendRevision(input: {
  revisions: Map<string, ConfigAssetRevisionRecord[]>;
  asset: ConfigAssetRecord;
  operation: ConfigAssetRevisionRecord["operation"];
  config: ConfigAssetRevisionRecord["config"];
  actor: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]["actor"];
  globalVersion: number;
  createdAt: string;
}): ConfigAssetRevisionRecord {
  const revision: ConfigAssetRevisionRecord = {
    id: createPlatformId("cfgr"),
    assetId: input.asset.id,
    clientInstanceId: input.asset.clientInstanceId,
    revision: input.asset.revision + 1,
    operation: input.operation,
    config: input.config ? structuredClone(input.config) : null,
    actor: input.actor ? structuredClone(input.actor) : null,
    globalVersion: input.globalVersion,
    createdAt: input.createdAt
  };
  input.revisions.set(input.asset.id, [
    ...(input.revisions.get(input.asset.id) ?? []),
    revision
  ]);
  return revision;
}

function cloneAsset(asset: ConfigAssetRecord): ConfigAssetRecord {
  return {
    ...asset,
    config: asset.config ? structuredClone(asset.config) : null
  };
}

function cloneRevision(revision: ConfigAssetRevisionRecord): ConfigAssetRevisionRecord {
  return {
    ...revision,
    config: revision.config ? structuredClone(revision.config) : null,
    actor: revision.actor ? structuredClone(revision.actor) : null
  };
}
