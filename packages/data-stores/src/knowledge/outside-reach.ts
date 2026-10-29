import {
  CONNECTION_ASSET_KIND,
  KNOWLEDGE_OPERATION_PREFIX,
  WORKFLOW_ASSET_KIND,
  parseConnectionOperationName,
  workflowStepsDeep,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { useOfOperations } from "../store-use";
import { appUse } from "../used-by";
import type { KnowledgeBaseDefinition } from "./definition";

// A Knowledge Base answers an outside client (an API key, the CLI or the platform MCP server,
// or a call made for one) only while the Connections its rows come from are open to outside
// clients: the Connection's admin decides whether its data leaves the instance, and a Knowledge
// Base must not hand a key what a Connection kept from outside clients (connections-and-secrets.md,
// Workflows started from outside, WF-OUT). The same rule refuses a Knowledge Base's source names
// to an outside call (`sourceNamesRight`).
//
// A source Connection of a Knowledge Base is one its definition names as a synced source, and
// one a published Workflow or App that adds rows to the Data Store it reads calls: the platform's
// own provenance of a store's rows (`used_by`). A synced source is read through the
// `document_source` capability, which no operation exposes to `outside`.

const connectionExposureSchema = z.object({
  operations: z.array(z.object({ name: z.string(), exposure: z.array(z.string()) }))
});

const publishedWorkflowSchema = z.object({
  manifest: z.object({
    name: z.string().optional(),
    steps: z.unknown(),
    tools: z.array(z.string()).optional()
  })
});

/** How many published assets of one kind a single read looks through. */
const PAGE_SIZE = 500;

type Deps = {
  clientInstanceId: ClientInstanceId;
  configAssets: Pick<ConfigAssetStore, "getConfigAsset" | "listPublishedConfigAssets">;
};

/** Every published asset of the kind, page by page. */
async function* publishedAssets(deps: Deps, kind: string): AsyncGenerator<ConfigAssetRecord> {
  let afterName: string | undefined;
  for (;;) {
    const page = await deps.configAssets.listPublishedConfigAssets({
      clientInstanceId: deps.clientInstanceId,
      kind,
      afterName,
      limit: PAGE_SIZE
    });
    yield* page;
    if (page.length < PAGE_SIZE) return;
    afterName = page.at(-1)?.name;
  }
}

/**
 * Whether the Knowledge Base reads rows that come from a Connection not open to outside
 * clients. A synced source always is (its capability is exposed to nobody outside). For a
 * Knowledge Base on a Data Store: a published Workflow that adds rows to the store and calls a
 * Connection operation not exposed to `outside` (or reads a Knowledge Base, which is closed to
 * outside clients), or a published App that adds rows and calls a Connection. A Connection
 * that is gone or unreadable counts as closed: the rule never guesses open.
 */
export async function knowledgeBaseReadsClosedConnection(
  deps: Deps,
  definition: KnowledgeBaseDefinition
): Promise<boolean> {
  if (definition.sources?.length) return true;
  if (!("backend" in definition)) return false;
  const store = definition.backend.dataStore;
  const exposures = new Map<string, Promise<Map<string, readonly string[]> | undefined>>();
  const exposuresOf = (connection: string) => {
    let pending = exposures.get(connection);
    if (!pending) {
      pending = deps.configAssets
        .getConfigAsset({
          clientInstanceId: deps.clientInstanceId,
          kind: CONNECTION_ASSET_KIND,
          name: connection
        })
        .then((asset) => {
          if (!asset || asset.status !== "active" || asset.scope.kind !== "instance") return;
          const parsed = connectionExposureSchema.safeParse(asset.config);
          return parsed.success
            ? new Map(parsed.data.operations.map((entry) => [entry.name, entry.exposure]))
            : undefined;
        });
      exposures.set(connection, pending);
    }
    return pending;
  };
  const closed = async (connection: string, operation?: string) => {
    const exposure = await exposuresOf(connection);
    if (!exposure) return true;
    // An App names a Connection and not one operation: every operation must be open.
    return operation === undefined
      ? [...exposure.values()].some((entry) => !entry.includes("outside"))
      : !exposure.get(operation)?.includes("outside");
  };

  for await (const asset of publishedAssets(deps, WORKFLOW_ASSET_KIND)) {
    if (asset.status !== "active") continue;
    const config = publishedWorkflowSchema.safeParse(asset.publishedConfig);
    if (!config.success) continue;
    const { manifest } = config.data;
    const operations = [
      ...workflowStepsDeep(manifest.steps).flatMap((step) =>
        step.type === "operation" && typeof step.operation === "string" ? [step.operation] : []
      ),
      ...(manifest.tools ?? [])
    ];
    if (!useOfOperations(operations, store, asset.name)?.writes) continue;
    for (const name of operations) {
      if (name.startsWith(KNOWLEDGE_OPERATION_PREFIX)) return true;
      const called = parseConnectionOperationName(name);
      if (called && (await closed(called.connection, called.operation))) return true;
    }
  }
  for await (const asset of publishedAssets(deps, "app")) {
    if (asset.status !== "active") continue;
    const use = appUse(asset, store);
    if (!use?.writes) continue;
    for (const connection of use.connections) {
      if (await closed(connection)) return true;
    }
  }
  return false;
}
