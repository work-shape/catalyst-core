import {
  createActorAccess,
  KNOWLEDGE_BASE_ACTIONS,
  type AssetScope,
  type ClientInstanceId,
  type LocaleCode,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { knowledgeBaseDefinitionSchema } from "./definition";

// A cold draft review, paged over people rather than a capped or approximate audience.
const AUDIENCE_PAGE_USERS = 200;
export async function knowledgePublishQuestion(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  input: { assetId: string; scope: AssetScope; config: unknown; locale?: LocaleCode }
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
    const account = binding?.accountLabel ?? source.connection;
    const folders = source.folders.join(", ");
    const one = source.folders.length === 1;
    lines.push(
      input.locale === "de"
        ? `${audience} ${audience === 1 ? "Person" : "Personen"} mit Zugriff auf „${definition.title}“ ${audience === 1 ? "findet" : "finden"} alles ${one ? "im Ordner" : "in den Ordnern"} ${folders}, gelesen mit dem gemeinsamen Konto ${account}. Die eigenen Rechte dieser Personen in der Quelle gelten hier nicht.`
        : `${audience} ${audience === 1 ? "person" : "people"} with access to “${definition.title}” can find everything in ${one ? "folder" : "folders"} ${folders}, read with the shared account ${account}. Their own rights at the source do not apply.`
    );
  }
  return lines;
}
