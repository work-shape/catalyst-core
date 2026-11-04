import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  AppError,
  asCollaborationWorkspaceId,
  isAgentAvailableInWorkspace,
  type AgentAvailability,
  type CollaborationWorkspaceId,
  type ConfigAssetStore
} from "@work-shape/catalyst-core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import {
  collaborationWorkspaces,
  configAssetAvailability,
  configAssets,
  configAssetState,
  configAssetWorkspaceAvailability
} from "./schema";

// The default agents: the instance's, and the one a Shared Workspace names for itself. Every
// workspace keeps one it may use: a workspace's own default stays available there, and the
// instance default stays available wherever a workspace names none.

/** The Shared Workspaces that are open, each with the default agent it names for itself. */
async function openSharedWorkspaces(tx: PostgresTransaction, clientInstanceId: string) {
  return tx
    .select({
      id: collaborationWorkspaces.id,
      name: collaborationWorkspaces.name,
      defaultAgentName: collaborationWorkspaces.defaultAgentName
    })
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, clientInstanceId),
        eq(collaborationWorkspaces.kind, "shared"),
        isNull(collaborationWorkspaces.deletionRequestedAt)
      )
    )
    .orderBy(asc(collaborationWorkspaces.name), asc(collaborationWorkspaces.id));
}

function workspaceList(workspaces: readonly { name: string }[]): string {
  return workspaces.map((workspace) => `'${workspace.name}'`).join(", ");
}

/**
 * Refuses an availability of an agent that leaves a workspace without its default: a Shared
 * Workspace that names the agent as its own default keeps it, and the instance default stays in
 * every workspace that names none, every Personal Workspace among them. Called under the lock
 * of the asset set's state row, which every change of a default holds too.
 */
export async function requireDefaultsKept(
  tx: PostgresTransaction,
  input: {
    clientInstanceId: string;
    agentName: string;
    availability: AgentAvailability;
    /** The agent is the instance default, or becomes it with this change. */
    instanceDefault: boolean;
  }
): Promise<void> {
  if (input.availability.mode === "all") return;
  const workspaces = await openSharedWorkspaces(tx, input.clientInstanceId);
  const offered = new Set<string>(input.availability.collaborationWorkspaceIds);
  const named = workspaces.filter(
    (workspace) => workspace.defaultAgentName === input.agentName && !offered.has(workspace.id)
  );
  if (named.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Agent '${input.agentName}' is the default agent of the workspace ${workspaceList(named)} and must stay available there`,
      {
        reason: "workspace_default_agent",
        collaborationWorkspaceIds: named.map((workspace) => workspace.id)
      }
    );
  }
  if (!input.instanceDefault) return;
  if (!input.availability.personalWorkspaces) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Default agent '${input.agentName}' must stay available in Personal Workspaces`,
      { reason: "instance_default_agent" }
    );
  }
  const uncovered = workspaces.filter(
    (workspace) => workspace.defaultAgentName === null && !offered.has(workspace.id)
  );
  if (uncovered.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Default agent '${input.agentName}' must stay available in every workspace that names no default agent of its own: ${workspaceList(uncovered)}`,
      {
        reason: "instance_default_agent",
        collaborationWorkspaceIds: uncovered.map((workspace) => workspace.id)
      }
    );
  }
}

/** The stored availability of one asset, or none. */
export async function storedAvailability(
  tx: PostgresTransaction,
  assetId: string
): Promise<AgentAvailability | undefined> {
  const [stored] = await tx
    .select({
      mode: configAssetAvailability.mode,
      personalWorkspaces: configAssetAvailability.personalWorkspaces
    })
    .from(configAssetAvailability)
    .where(eq(configAssetAvailability.assetId, assetId))
    .limit(1);
  if (!stored) return undefined;
  const workspaces = await tx
    .select({ id: configAssetWorkspaceAvailability.collaborationWorkspaceId })
    .from(configAssetWorkspaceAvailability)
    .where(eq(configAssetWorkspaceAvailability.assetId, assetId));
  return {
    ...stored,
    collaborationWorkspaceIds: workspaces.map(({ id }) => asCollaborationWorkspaceId(id))
  };
}

/** The availability of the active agent of this name, where it is one. */
async function activeAgentAvailability(
  tx: PostgresTransaction,
  clientInstanceId: string,
  agentName: string
): Promise<{ id: string; availability: AgentAvailability | undefined } | undefined> {
  const [agent] = await tx
    .select({ id: configAssets.id })
    .from(configAssets)
    .where(
      and(
        eq(configAssets.clientInstanceId, clientInstanceId),
        eq(configAssets.kind, "agent"),
        eq(configAssets.name, agentName),
        eq(configAssets.status, "active")
      )
    )
    .limit(1);
  if (!agent) return undefined;
  return { id: agent.id, availability: await storedAvailability(tx, agent.id) };
}

export async function listWorkspaceDefaultAgents(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listWorkspaceDefaultAgents"]>[0]
): Promise<Map<CollaborationWorkspaceId, string>> {
  const rows = await db
    .select({
      id: collaborationWorkspaces.id,
      defaultAgentName: collaborationWorkspaces.defaultAgentName
    })
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.kind, "shared"),
        isNull(collaborationWorkspaces.deletionRequestedAt),
        input.collaborationWorkspaceId === undefined
          ? undefined
          : eq(collaborationWorkspaces.id, input.collaborationWorkspaceId)
      )
    );
  return new Map(
    rows.flatMap((row) =>
      row.defaultAgentName === null
        ? []
        : [[asCollaborationWorkspaceId(row.id), row.defaultAgentName] as const]
    )
  );
}

export async function setWorkspaceDefaultAgent(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["setWorkspaceDefaultAgent"]>[0]
): Promise<{ version: number; agentId?: string }> {
  return db.transaction(async (tx) => {
    // The lock every change of an availability and of the instance default holds.
    const [state] = await tx
      .select()
      .from(configAssetState)
      .where(eq(configAssetState.clientInstanceId, input.clientInstanceId))
      .for("update")
      .limit(1);
    const [workspace] = await tx
      .select({
        id: collaborationWorkspaces.id,
        kind: collaborationWorkspaces.kind,
        name: collaborationWorkspaces.name
      })
      .from(collaborationWorkspaces)
      .where(
        and(
          eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
          eq(collaborationWorkspaces.id, input.collaborationWorkspaceId),
          isNull(collaborationWorkspaces.deletionRequestedAt)
        )
      )
      .for("update")
      .limit(1);
    if (!workspace) throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    if (workspace.kind !== "shared") {
      throw new AppError(
        "VALIDATION_FAILED",
        "Only a Shared Workspace names a default agent of its own",
        { reason: "personal_workspace" }
      );
    }
    const here = { kind: "shared" as const, id: asCollaborationWorkspaceId(workspace.id) };
    let agentId: string | undefined;
    if (input.agentName !== null) {
      const agent = await activeAgentAvailability(tx, input.clientInstanceId, input.agentName);
      if (!agent) {
        throw new AppError("NOT_FOUND", `Config agent '${input.agentName}' was not found`);
      }
      if (!isAgentAvailableInWorkspace(agent.availability, here)) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Agent '${input.agentName}' is not available in the workspace '${workspace.name}'`,
          { reason: "agent_not_available", collaborationWorkspaceIds: [workspace.id] }
        );
      }
      agentId = agent.id;
    } else if (state?.defaultAgentName) {
      // Following the instance default again needs it here: no workspace is left without one.
      const instanceDefault = await activeAgentAvailability(
        tx,
        input.clientInstanceId,
        state.defaultAgentName
      );
      if (instanceDefault && !isAgentAvailableInWorkspace(instanceDefault.availability, here)) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Default agent '${state.defaultAgentName}' is not available in the workspace '${workspace.name}': make it available there first`,
          { reason: "instance_default_agent", collaborationWorkspaceIds: [workspace.id] }
        );
      }
    }
    const now = new Date();
    await tx
      .update(collaborationWorkspaces)
      .set({ defaultAgentName: input.agentName, updatedAt: now })
      .where(eq(collaborationWorkspaces.id, workspace.id));
    // What a run in the workspace starts with is part of the set as a run sees it.
    const version = (state?.version ?? 0) + 1;
    if (state) {
      await tx
        .update(configAssetState)
        .set({ version, updatedAt: now })
        .where(eq(configAssetState.clientInstanceId, input.clientInstanceId));
    }
    return { version: state ? version : 0, ...(agentId === undefined ? {} : { agentId }) };
  });
}

/**
 * A new Shared Workspace names no default of its own, so the instance default is offered in it
 * where the instance offers it only in selected workspaces.
 */
export async function offerInstanceDefaultIn(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; collaborationWorkspaceId: string }
): Promise<void> {
  const [state] = await tx
    .select()
    .from(configAssetState)
    .where(eq(configAssetState.clientInstanceId, input.clientInstanceId))
    .for("update")
    .limit(1);
  if (!state?.defaultAgentName) return;
  const agent = await activeAgentAvailability(tx, input.clientInstanceId, state.defaultAgentName);
  if (agent?.availability?.mode !== "selected") return;
  await tx
    .insert(configAssetWorkspaceAvailability)
    .values({
      assetId: agent.id,
      collaborationWorkspaceId: asCollaborationWorkspaceId(input.collaborationWorkspaceId)
    })
    .onConflictDoNothing();
  await tx
    .update(configAssetState)
    .set({ version: state.version + 1, updatedAt: new Date() })
    .where(eq(configAssetState.clientInstanceId, input.clientInstanceId));
}

/**
 * Refuses deleting agents a Shared Workspace names as its default, naming the workspace, as
 * deleting the instance default is refused.
 */
export async function requireNoWorkspaceDefaultAmong(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; agentNames: readonly string[] }
): Promise<void> {
  if (input.agentNames.length === 0) return;
  const named = (await openSharedWorkspaces(tx, input.clientInstanceId)).filter(
    (workspace) =>
      workspace.defaultAgentName !== null && input.agentNames.includes(workspace.defaultAgentName)
  );
  const [first] = named;
  if (!first) return;
  throw new AppError(
    "VALIDATION_FAILED",
    `Agent '${first.defaultAgentName}' is the default agent of the workspace ${workspaceList(named.filter((workspace) => workspace.defaultAgentName === first.defaultAgentName))}: name another default there first`,
    {
      reason: "workspace_default_agent",
      collaborationWorkspaceIds: named.map((workspace) => workspace.id)
    }
  );
}

/**
 * Agents removed with the workspace that owned them stop being another workspace's default.
 * Those workspaces follow the instance default again, which is offered there.
 */
export async function forgetRemovedWorkspaceDefaults(
  tx: PostgresTransaction,
  input: { clientInstanceId: string; agentNames: readonly string[] }
): Promise<void> {
  if (input.agentNames.length === 0) return;
  const forgotten = await tx
    .update(collaborationWorkspaces)
    .set({ defaultAgentName: null })
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        inArray(collaborationWorkspaces.defaultAgentName, [...input.agentNames])
      )
    )
    .returning({ id: collaborationWorkspaces.id });
  for (const workspace of forgotten) {
    await offerInstanceDefaultIn(tx, {
      clientInstanceId: input.clientInstanceId,
      collaborationWorkspaceId: workspace.id
    });
  }
}
