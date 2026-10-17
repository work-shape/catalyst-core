import {
  createActorAccess,
  KNOWLEDGE_BASE_ACTIONS,
  type AssetScope,
  type ClientInstanceId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { knowledgeBaseDefinitionSchema } from "./definition";

// A cold draft review, paged over people rather than a capped or approximate audience.
const AUDIENCE_PAGE_USERS = 200;
export async function knowledgePublishQuestion(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  input: { assetId: string; scope: AssetScope; config: unknown }
): Promise<string[]> {
  const definition = knowledgeBaseDefinitionSchema.parse(input.config);
  if (!definition.sources?.length) return [];
  const resource = {
    kind: "knowledge_base",
    assetId: input.assetId,
    name: definition.name,
    ...(input.scope.kind === "workspace" ? { workspaceId: input.scope.workspaceId } : {})
  };
  let audience = 0,
    after: readonly (string | number)[] | undefined;
  for (;;) {
    const users = await stores.users.listUsers({
      clientInstanceId,
      page: { limit: AUDIENCE_PAGE_USERS, ...(after ? { after } : {}) }
    });
    for (const user of users) {
      const persisted = await stores.access.loadPersistedAccess({
        clientInstanceId,
        holder: { kind: "user", id: user.id }
      });
      if (
        createActorAccess(
          {
            kind: "user",
            id: user.id,
            clientInstanceId,
            roles: user.roles,
            permissionRefs: user.permissionRefs
          },
          persisted
        ).authorize(KNOWLEDGE_BASE_ACTIONS.use, resource).allowed
      )
        audience++;
    }
    const last = users.at(-1);
    if (users.length < AUDIENCE_PAGE_USERS || !last) break;
    after = [last.displayLabel, last.id];
  }
  const lines = [];
  for (const source of definition.sources) {
    const connection = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: source.connection
    });
    const binding = connection
      ? await stores.connections.getConnectionBinding({
          clientInstanceId,
          connectionAssetId: connection.id,
          subject: "shared"
        })
      : undefined;
    lines.push(
      `${audience} people with access to ${definition.title} can find everything in folders ${source.folders.join(", ")}, read with the shared account ${binding?.accountLabel ?? source.connection}. Their own rights at the source do not apply.`
    );
  }
  return lines;
}
