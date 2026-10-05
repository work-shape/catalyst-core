import {
  AppError,
  assertConfigAssetBases,
  createPlatformId,
  resolveInitialAgentAvailabilityMode,
  type AgentAvailability,
  type CollaborationWorkspaceId,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type ConfigAssetStore
} from "./index";

export class InMemoryConfigAssetStore implements ConfigAssetStore {
  private states = new Map<string, ConfigAssetState>();
  private assets = new Map<string, ConfigAssetRecord>();
  private revisions = new Map<string, ConfigAssetRevisionRecord[]>();
  /** Keyed by asset id. */
  private availability = new Map<string, AgentAvailability>();

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
    const current = new Map<
      string,
      { status: "active" | "deleted"; revision: ConfigAssetRevisionRecord }
    >();
    for (const asset of this.assets.values()) {
      if (asset.clientInstanceId !== input.clientInstanceId) {
        continue;
      }
      const revision = this.revisions.get(asset.id)?.at(-1);
      if (revision) {
        current.set(`${asset.kind}:${asset.name}`, { status: asset.status, revision });
      }
    }
    assertConfigAssetBases(input, currentState, current);

    const states = new Map(this.states);
    const assets = new Map(
      [...this.assets].map(([key, asset]) => [key, cloneAsset(asset)] as const)
    );
    const revisions = new Map(
      [...this.revisions].map(
        ([assetId, records]) => [assetId, records.map(cloneRevision)] as const
      )
    );
    const availability = new Map(
      [...this.availability].map(([assetId, record]) => [assetId, cloneAvailability(record)])
    );
    const initialAvailability = (): AgentAvailability => ({
      mode: initialAgentMode,
      personalWorkspaces: false,
      collaborationWorkspaceIds: []
    });
    const initialAgentMode = resolveInitialAgentAvailabilityMode(
      input.initialAgentAvailability,
      input.mutations.some((mutation) => {
        if (mutation.type !== "delete" || mutation.kind !== "agent") {
          return false;
        }
        const asset = assets.get(
          createAssetKey({ clientInstanceId: input.clientInstanceId, ...mutation })
        );
        return asset !== undefined && availability.get(asset.id)?.mode === "selected";
      })
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
          origin: input.origin,
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
        availability.delete(existing.id);
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
        if (mutation.kind === "agent") {
          availability.set(assetId, initialAvailability());
        }
        revisions.set(assetId, [
          {
            id: revisionId,
            assetId,
            clientInstanceId: input.clientInstanceId,
            revision: 1,
            operation: mutation.operation ?? "create",
            config: structuredClone(config),
            actor: input.actor ? structuredClone(input.actor) : null,
            ...(input.origin ? { origin: structuredClone(input.origin) } : {}),
            globalVersion: version,
            createdAt: now
          }
        ]);
        continue;
      }

      const revision = appendRevision({
        revisions,
        asset: existing,
        operation: mutation.operation ?? (existing.status === "deleted" ? "create" : "update"),
        config,
        actor: input.actor,
        origin: input.origin,
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
      if (existing.kind === "agent" && existing.status === "deleted") {
        availability.set(existing.id, initialAvailability());
      }
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
      if (availability.get(defaultAgent.id)?.mode !== "all") {
        throw new AppError(
          "VALIDATION_FAILED",
          `Default agent '${defaultAgentName}' must be available in all workspaces`
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
    this.availability = availability;
    return { version };
  }

  async listAgentAvailability(
    input: Parameters<ConfigAssetStore["listAgentAvailability"]>[0]
  ): Promise<Map<string, AgentAvailability>> {
    const result = new Map<string, AgentAvailability>();
    for (const asset of this.assets.values()) {
      const record = this.availability.get(asset.id);
      if (
        record &&
        asset.clientInstanceId === input.clientInstanceId &&
        asset.kind === "agent" &&
        asset.status === "active"
      ) {
        result.set(asset.name, cloneAvailability(record));
      }
    }
    return result;
  }

  async setAgentAvailability(
    input: Parameters<ConfigAssetStore["setAgentAvailability"]>[0]
  ): Promise<AgentAvailability> {
    const asset = this.assets.get(
      createAssetKey({
        clientInstanceId: input.clientInstanceId,
        kind: "agent",
        name: input.agentName
      })
    );
    if (!asset || asset.status !== "active") {
      throw new AppError("NOT_FOUND", `Config agent '${input.agentName}' was not found`);
    }
    if (
      input.availability.mode !== "all" &&
      this.states.get(input.clientInstanceId)?.defaultAgentName === input.agentName
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Default agent '${input.agentName}' must be available in all workspaces`
      );
    }
    this.availability.set(asset.id, cloneAvailability(input.availability));
    return cloneAvailability(input.availability);
  }

  /** Mirrors the database cascade from a deleted Collaboration Workspace. */
  removeWorkspaceAvailability(collaborationWorkspaceId: CollaborationWorkspaceId): void {
    for (const record of this.availability.values()) {
      record.collaborationWorkspaceIds = record.collaborationWorkspaceIds.filter(
        (id) => id !== collaborationWorkspaceId
      );
    }
  }
}

function createAssetKey(input: { clientInstanceId: string; kind: string; name: string }): string {
  return JSON.stringify([input.clientInstanceId, input.kind, input.name]);
}

function appendRevision(input: {
  revisions: Map<string, ConfigAssetRevisionRecord[]>;
  asset: ConfigAssetRecord;
  operation: ConfigAssetRevisionRecord["operation"];
  config: ConfigAssetRevisionRecord["config"];
  actor: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]["actor"];
  origin: ConfigAssetRevisionRecord["origin"];
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
    ...(input.origin ? { origin: structuredClone(input.origin) } : {}),
    globalVersion: input.globalVersion,
    createdAt: input.createdAt
  };
  input.revisions.set(input.asset.id, [...(input.revisions.get(input.asset.id) ?? []), revision]);
  return revision;
}

function cloneAsset(asset: ConfigAssetRecord): ConfigAssetRecord {
  return {
    ...asset,
    config: asset.config ? structuredClone(asset.config) : null
  };
}

function cloneAvailability(availability: AgentAvailability): AgentAvailability {
  return {
    ...availability,
    collaborationWorkspaceIds: [...new Set(availability.collaborationWorkspaceIds)].sort()
  };
}

function cloneRevision(revision: ConfigAssetRevisionRecord): ConfigAssetRevisionRecord {
  return {
    ...revision,
    config: revision.config ? structuredClone(revision.config) : null,
    ...(revision.origin ? { origin: structuredClone(revision.origin) } : {}),
    actor: revision.actor ? structuredClone(revision.actor) : null
  };
}
