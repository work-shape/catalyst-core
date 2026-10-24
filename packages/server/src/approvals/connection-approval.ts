import {
  CONNECTION_ASSET_KIND,
  parseConnectionOperationName,
  type AccessResource,
  type ActorAccess,
  type ApprovalFurtherRight,
  type ClientInstanceId,
  type ConfigAssetStore,
  type JsonObject,
  type OperationResource
} from "@work-shape/catalyst-core";
import { z } from "zod";

// `connection.approve` decides an Approval Request for an operation or a configuration change
// on one Connection (connections-and-secrets.md, Rights). A held call names the Connection it
// is about in its request's `subject`, frozen when the call was held: the asset id, so a
// Connection deleted and made again under the same name is another Connection. The call runs
// as the person who made it, so deciding it gives the approver no right of theirs.

const CONNECTION_APPROVE_ACTION = "connection.approve";

/** The calls on a Connection's configuration that a policy may hold, by their input. */
const CONFIG_CHANGE_OPERATIONS: readonly string[] = ["assets.put", "assets.delete"];

const subjectSchema = z.object({
  connectionAssetId: z.string().min(1),
  connection: z.string().min(1)
});

const assetInputSchema = z.object({ kind: z.literal(CONNECTION_ASSET_KIND), name: z.string() });

/**
 * The subject of the request a held call files, where the call is about one stored
 * Connection: one of its operations, or a save or deletion of its definition. A call that
 * creates a Connection is about none yet.
 */
export async function connectionSubjectOf(
  input: {
    clientInstanceId: ClientInstanceId;
    store: Pick<ConfigAssetStore, "getConfigAsset">;
  },
  operation: string,
  callInput: unknown,
  resource: OperationResource | undefined
): Promise<JsonObject | undefined> {
  const named = parseConnectionOperationName(operation);
  if (named) {
    return resource?.kind === CONNECTION_ASSET_KIND && resource.assetId !== undefined
      ? { connectionAssetId: resource.assetId, connection: named.connection }
      : undefined;
  }
  if (!CONFIG_CHANGE_OPERATIONS.includes(operation)) return undefined;
  const asset = assetInputSchema.safeParse(callInput);
  if (!asset.success) return undefined;
  const stored = await input.store.getConfigAsset({
    clientInstanceId: input.clientInstanceId,
    kind: CONNECTION_ASSET_KIND,
    name: asset.data.name
  });
  return stored?.status === "active"
    ? { connectionAssetId: stored.id, connection: stored.name }
    : undefined;
}

/** `connection.approve` on the Connection a request's subject names, or nothing. */
export function connectionApproveRight(
  subject: JsonObject | undefined
): ApprovalFurtherRight | undefined {
  const parsed = subjectSchema.safeParse(subject);
  if (!parsed.success) return undefined;
  const resource: AccessResource = {
    kind: CONNECTION_ASSET_KIND,
    name: parsed.data.connection,
    assetId: parsed.data.connectionAssetId
  };
  return { permission: CONNECTION_APPROVE_ACTION, resource };
}

/** The subjects of the requests `access` decides with `connection.approve` alone. */
export async function connectionApproveSubjects(
  input: {
    clientInstanceId: ClientInstanceId;
    store: Pick<ConfigAssetStore, "listActiveConfigAssets">;
  },
  access: ActorAccess
): Promise<JsonObject[]> {
  if (
    !access.authorize(CONNECTION_APPROVE_ACTION).allowed &&
    !access.holdsGrantAt(CONNECTION_APPROVE_ACTION, ["asset"])
  )
    return [];
  const connections = await input.store.listActiveConfigAssets({
    clientInstanceId: input.clientInstanceId,
    kind: CONNECTION_ASSET_KIND
  });
  return connections
    .filter(
      (connection) =>
        access.authorize(CONNECTION_APPROVE_ACTION, {
          kind: CONNECTION_ASSET_KIND,
          name: connection.name,
          assetId: connection.id
        }).allowed
    )
    .map((connection) => ({ connectionAssetId: connection.id }));
}
