import {
  AppError,
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_DESCRIPTION_TOOL_NAME,
  dataStoreDescriptionInputSchema,
  dataStoreDescriptionSchema,
  dataStoreOperationName,
  type ActorAccess,
  type OperationDefinition,
  type OperationExecutionContext
} from "@work-shape/catalyst-core";
import { readTables } from "./catalog";
import { dataStoreDefinitionSchema } from "./definition";
import { readStore } from "./published-store";
import type { DataStoreRuntime } from "./runtime";
import { assetResource } from "./store-audience";
import { usedBy } from "./used-by";

const unavailable = () =>
  new AppError("NOT_FOUND", "This Data Store is not available to you.", undefined, {
    exposeMessage: true
  });

/** One reader boundary for internal agents and outside keys. No row operation is called. */
export function dataStoreDescriptionOperation(runtime: DataStoreRuntime): OperationDefinition {
  async function readable(name: string, access: ActorAccess) {
    const asset = await runtime.stores.configAssets.getConfigAsset({
      clientInstanceId: runtime.clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name
    });
    if (
      asset?.status !== "active" ||
      !access.authorize(DATA_STORE_ACTIONS.read, assetResource(asset)).allowed
    )
      throw unavailable();
    return asset;
  }
  return {
    name: DATA_STORE_DESCRIPTION_TOOL_NAME,
    effect: "reading",
    action: null,
    scope: "config_assets:read",
    auth: "principal",
    module: "dataStores",
    timeoutMs: 15_000,
    inputSchema: dataStoreDescriptionInputSchema,
    outputSchema: dataStoreDescriptionSchema,
    resource: () => undefined,
    async authorize(input, { access }) {
      await readable(dataStoreDescriptionInputSchema.parse(input).store, access);
      return { allowed: true };
    },
    async policyTargets(input) {
      const { store } = dataStoreDescriptionInputSchema.parse(input);
      const asset = await runtime.stores.configAssets.getConfigAsset({
        clientInstanceId: runtime.clientInstanceId,
        kind: DATA_STORE_ASSET_KIND,
        name: store
      });
      return [
        {
          assetKind: DATA_STORE_ASSET_KIND,
          ...(asset?.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
        }
      ];
    },
    async execute(input, context: OperationExecutionContext) {
      const { store: name } = dataStoreDescriptionInputSchema.parse(input);
      const asset = await readable(name, context.access);
      // Match asset discovery's transcript boundary: another reader's metadata never enters
      // a shared transcript merely because the agent's person may read it.
      if (context.origin.kind === "agent") {
        const conversation = await runtime.stores.conversations.getConversation(
          runtime.clientInstanceId,
          context.origin.conversationId
        );
        if (!conversation) throw unavailable();
        if (
          conversation.visibility !== "private" &&
          !(
            conversation.subject?.kind === DATA_STORE_ASSET_KIND &&
            conversation.subject.name === name
          )
        ) {
          const workspace = await runtime.stores.workspaces.getWorkspace(
            runtime.clientInstanceId,
            conversation.collaborationWorkspaceId
          );
          if (workspace?.kind !== "personal")
            throw new AppError(
              "FORBIDDEN",
              "Describe this Data Store in a private conversation.",
              undefined,
              { exposeMessage: true }
            );
        }
      }
      const definition = dataStoreDefinitionSchema.parse(asset.publishedConfig ?? asset.config);
      const store = await readStore(runtime, name);
      const schemaAvailable = store?.record.status === "ready";
      const tables = schemaAvailable
        ? await readTables(runtime.server.executor, {
            ...runtime.server.asPlatform(store.record.location.database),
            ...(context.runtime.signal ? { signal: context.runtime.signal } : {})
          })
        : [];
      const uses = store ? await usedBy(runtime, store, context.access) : undefined;
      const use = (kind: string, item: { name: string; title: string }) => ({
        kind,
        name: item.name,
        title: item.title
      });
      const using = uses
        ? [
            ...uses.workflows.map((item) => ({
              ...use("workflow", item),
              reads: item.reads,
              writes: item.writes
            })),
            ...uses.apps.map((item) => ({
              ...use("app", item),
              reads: item.reads,
              writes: item.writes
            })),
            ...(uses.agents ?? []).map((item) => ({
              ...use("agent", item),
              reads: item.reads,
              writes: item.writes
            })),
            ...uses.knowledgeBases.map((item) => ({
              ...use("knowledge_base", item),
              reads: true,
              writes: false
            }))
          ]
        : [];
      const canReadRows =
        schemaAvailable &&
        context.origin.kind === "agent" &&
        (["query", "preview_rows"] as const).some((verb) =>
          context.runtime.offeredDataToolNames?.includes(dataStoreOperationName(name, verb))
        );
      return dataStoreDescriptionSchema.parse({
        name,
        title: definition.title,
        description: definition.description,
        owner: asset.scope,
        published: asset.publishedRevision !== undefined,
        schemaAvailable,
        tables: tables.map((table) => ({
          name: table.name,
          description: table.comment,
          rowEstimate: table.rowEstimate ?? null,
          fields: table.columns.map((column) => ({
            name: column.name,
            type: column.type,
            nullable: column.nullable,
            description:
              column.comment ??
              `Field ${column.name}; stores ${column.type} values${column.nullable ? " and may be empty" : " and is required"}.`
          }))
        })),
        filledBy: using
          .filter((item) => item.writes)
          .map(({ kind, name, title }) => ({ kind, name, title })),
        readBy: using
          .filter((item) => item.reads)
          .map(({ kind, name, title }) => ({ kind, name, title })),
        usesTruncated: uses
          ? uses.truncated || uses.hidden.fills > 0 || uses.hidden.reads > 0
          : false,
        rights: {
          read: true,
          add: context.access.authorize(DATA_STORE_ACTIONS.insert, assetResource(asset)).allowed,
          change: context.access.authorize(DATA_STORE_ACTIONS.execute, assetResource(asset)).allowed
        },
        chat: {
          canReadRows,
          reason: canReadRows
            ? "This chat has a row-reading tool for this Data Store; every call still checks your rights."
            : "This call has no row-reading tool for this Data Store. Describing it grants no row access.",
          ...(canReadRows
            ? {}
            : {
                nextStep:
                  context.origin.kind === "agent"
                    ? `Call data_store.use with the name '${name}' to read its rows in this chat, next to what the chat is about. The person's own store is added at once; any other store waits for the person's click on a card.`
                    : "Outside clients read no rows. An agent in a chat reads them once data_store.use added the store there."
              })
        }
      });
    }
  };
}
