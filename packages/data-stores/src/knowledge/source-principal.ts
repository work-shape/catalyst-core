import { createHash } from "node:crypto";
import {
  asUserId,
  AppError,
  CONNECTION_ASSET_KIND,
  CONNECTION_ACTIONS,
  createActorAccess,
  DocumentSourceError,
  LEGACY_LIST_GRANTOR,
  type ActorAccess,
  type ClientInstanceId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { KnowledgeBaseDefinition } from "./definition";

type Source = NonNullable<KnowledgeBaseDefinition["sources"]>[number];
async function sourceConnection(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  name: string
) {
  const asset = await stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: CONNECTION_ASSET_KIND,
    name
  });
  if (!asset || asset.status !== "active")
    throw new AppError("NOT_FOUND", "The source Connection is not available");
  return asset;
}

/** The publish transaction owns the principal, its grants and its initial jobs together. */
export async function publishSourcePrincipal(
  stores: PlatformStores,
  input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    name: string;
    access: ActorAccess;
    sources: Source[];
    documentSourceOffered?: (config: unknown) => boolean;
    previous: Source[];
  }
) {
  const { clientInstanceId, assetId, sources, previous, access } = input;
  for (const old of previous) {
    const next = sources.find((source) => source.id === old.id);
    if (!next || JSON.stringify(next) !== JSON.stringify(old))
      throw new AppError(
        "VALIDATION_FAILED",
        "Changing a source boundary or removing a source is not supported yet; the published source is kept.",
        { reason: "not_supported_yet" },
        { exposeMessage: true }
      );
  }
  const connections = await Promise.all(
    sources.map(async (source) => {
      const asset = await sourceConnection(stores, clientInstanceId, source.connection);
      if (!previous.some((old) => old.id === source.id))
        access.require(CONNECTION_ACTIONS.use, {
          kind: CONNECTION_ASSET_KIND,
          assetId: asset.id,
          name: asset.name
        });
      if (input.documentSourceOffered && !input.documentSourceOffered(asset.config))
        throw new AppError(
          "VALIDATION_FAILED",
          "The Connection does not offer document_source",
          { reason: "document_source_unavailable" },
          { exposeMessage: true }
        );
      return asset;
    })
  );
  if (!sources.length) return undefined;
  const owner = { kind: "knowledge_base", assetId };
  const principal =
    (await stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner })) ??
    (await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      owner,
      displayLabel: `Knowledge Base ${input.name}`,
      name: `kb-${createHash("sha256").update(assetId).digest("hex").slice(0, 48)}`
    }));
  for (const connection of connections) {
    const held = await stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action: CONNECTION_ACTIONS.use,
      scopeKind: "asset",
      scopeId: connection.id
    });
    if (!held.some((grant) => grant.effect === "allow"))
      await stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id,
        action: CONNECTION_ACTIONS.use,
        effect: "allow",
        scopeKind: "asset",
        scopeId: connection.id,
        grantedBy: asUserId(LEGACY_LIST_GRANTOR)
      });
  }
  return principal;
}

/** Re-read both the account and its persisted rights for each batch and after credentials open. */
export async function sourceAuthority(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  assetId: string,
  connection: string
) {
  const principal = await stores.apiAccess.findServicePrincipalByOwner({
    clientInstanceId,
    owner: { kind: "knowledge_base", assetId }
  });
  if (!principal || principal.status !== "active")
    throw new DocumentSourceError("unauthorized", "The ingestion principal is unavailable");
  const asset = await sourceConnection(stores, clientInstanceId, connection);
  const require = async () => {
    const persisted = await stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "service_principal", id: principal.id }
    });
    const access = createActorAccess(
      {
        kind: "service_principal",
        id: principal.id,
        clientInstanceId,
        roles: [],
        permissionRefs: principal.permissionRefs
      },
      persisted
    );
    if (
      !access.authorize(CONNECTION_ACTIONS.use, {
        kind: CONNECTION_ASSET_KIND,
        assetId: asset.id,
        name: asset.name
      }).allowed
    )
      throw new DocumentSourceError("unauthorized", "The ingestion principal needs connection.use");
  };
  await require();
  return { require };
}
export type SourceAuthority = Awaited<ReturnType<typeof sourceAuthority>>;
export async function requireSourceUse(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  assetId: string,
  connection: string
) {
  await sourceAuthority(stores, clientInstanceId, assetId, connection);
}
