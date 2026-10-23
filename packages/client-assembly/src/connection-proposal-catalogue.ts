import {
  connectionOriginOf,
  readConnections,
  type Catalogue
} from "@work-shape/catalyst-connections";
import type { Authorizer, ConnectorTypeRegistry, PlatformStores } from "@work-shape/catalyst-core";
import type { ConnectionProposalCatalogue } from "@work-shape/catalyst-tool-execution";

/** Agent-facing metadata only. No secret is opened and only the viewer's binding is read. */
export function connectionProposalCatalogue(input: {
  catalogue: Catalogue;
  connectorTypes: ConnectorTypeRegistry;
  stores: PlatformStores;
  authorizer(): Authorizer | undefined;
}): ConnectionProposalCatalogue {
  return {
    async mayWrite(context) {
      const access = await input.authorizer()?.forActor(context.user);
      return access?.authorize("connection.write", { kind: "connection" }).allowed ?? false;
    },
    async read(context) {
      const { clientInstanceId } = context;
      const connections = await readConnections({ ...input, clientInstanceId });
      return Promise.all(
        input.catalogue.entries
          .filter((entry) => entry.offered)
          .map(async (entry) => ({
            id: entry.id,
            title:
              typeof entry.title === "string"
                ? entry.title
                : (entry.title[context.locale ?? "en"] ?? entry.title.en ?? entry.id),
            category: entry.category,
            parts: await Promise.all(
              entry.parts.map(async (part) => {
                const matches = connections.filter(
                  ({ config }) =>
                    config.catalogue?.entry === entry.id && config.catalogue.part === part.part
                );
                const states = await Promise.all(
                  matches.map(async (connection) => {
                    const origin = connection.type
                      ? connectionOriginOf(connection.type, connection.config)
                      : undefined;
                    const secret = await input.stores.connections.findSecret({
                      clientInstanceId,
                      binding: { connectionAssetId: connection.assetId, subject: "shared" }
                    });
                    const binding =
                      connection.config.credentialMode === "user"
                        ? await input.stores.connections.getConnectionBinding({
                            clientInstanceId,
                            connectionAssetId: connection.assetId,
                            subject: `user:${context.user.id}`
                          })
                        : undefined;
                    return {
                      name: connection.config.name,
                      clientSecretSet:
                        secret !== undefined && origin !== undefined && secret.origin === origin,
                      credentialMode: connection.config.credentialMode,
                      ...(connection.config.credentialMode === "user"
                        ? {
                            bindingState:
                              binding?.origin === origin && binding?.state === "connected"
                                ? ("connected" as const)
                                : binding?.origin === origin && binding?.state === "needs_reconnect"
                                  ? ("needs_reconnect" as const)
                                  : ("not_connected" as const)
                          }
                        : {})
                    };
                  })
                );
                // Prefer an installation that can connect; keep selection deterministic.
                states.sort(
                  (a, b) =>
                    Number(b.clientSecretSet) - Number(a.clientSecretSet) ||
                    a.name.localeCompare(b.name)
                );
                const connection = states[0];
                return {
                  part: part.part,
                  connectorType: part.connectorType,
                  name: part.name,
                  credentialModes: [...part.credentialModes],
                  defaultCredentialMode: part.defaultCredentialMode,
                  hosts: [...part.hosts],
                  ...(connection === undefined ? {} : { connection })
                };
              })
            )
          }))
      );
    }
  };
}
