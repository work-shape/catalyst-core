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
// one a published Workflow, App or live agent that adds rows to the Data Store it reads calls:
// the platform's own provenance of a store's rows (`used_by`). A writer set that is too large
// to read, or an asset that cannot be read, counts as closed (manager, 2026-10-29). A synced source is read through the
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

/** How many pages of one kind a read looks through; more is an unknown writer set. */
const PAGE_SIZE = 500;
const MAX_PAGES = 10;

const AGENT_KIND = "agent";
const agentToolsSchema = z.object({ toolNames: z.array(z.string()) });
const appActionsSchema = z.object({ manifest: z.object({ actions: z.array(z.unknown()) }) });

type Deps = {
  clientInstanceId: ClientInstanceId;
  configAssets: Pick<
    ConfigAssetStore,
    "getConfigAsset" | "listPublishedConfigAssets" | "listActiveConfigAssets"
  >;
};

/** More assets exist than a read looks through: who writes the store is not known. */
class WriterSetUnknown extends Error {}

/** Every asset of the kind, page by page; an agent's live config, the others' published one. */
async function* assetsOf(deps: Deps, kind: string): AsyncGenerator<ConfigAssetRecord> {
  let afterName: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new WriterSetUnknown();
    const input = { clientInstanceId: deps.clientInstanceId, kind, afterName, limit: PAGE_SIZE };
    const found = await (kind === AGENT_KIND
      ? deps.configAssets.listActiveConfigAssets(input)
      : deps.configAssets.listPublishedConfigAssets(input));
    yield* found;
    if (found.length < PAGE_SIZE) return;
    afterName = found.at(-1)?.name;
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
  try {
    return await storeFilledFromClosedConnection(deps, definition.backend.dataStore);
  } catch (error) {
    // A writer set that is too large to read, or a definition that cannot be read, is unknown.
    if (error instanceof WriterSetUnknown) return true;
    throw error;
  }
}

async function storeFilledFromClosedConnection(deps: Deps, store: string): Promise<boolean> {
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

  for await (const asset of assetsOf(deps, WORKFLOW_ASSET_KIND)) {
    if (asset.status !== "active") continue;
    const config = publishedWorkflowSchema.safeParse(asset.publishedConfig);
    // A published Workflow that cannot be read may write the store: unknown counts as closed.
    if (!config.success) return true;
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
  for await (const asset of assetsOf(deps, "app")) {
    if (asset.status !== "active") continue;
    if (!appActionsSchema.safeParse(asset.publishedConfig).success) return true;
    const use = appUse(asset, store);
    if (!use?.writes) continue;
    for (const connection of use.connections) {
      if (await closed(connection)) return true;
    }
  }
  // An agent's tools are its live config. A tool of the store that adds rows, beside a Connection
  // tool or a Knowledge Base tool of the same agent, fills the store from them (DS-13c).
  for await (const asset of assetsOf(deps, AGENT_KIND)) {
    if (asset.status !== "active") continue;
    const tools = agentToolsSchema.safeParse(asset.config);
    if (!tools.success) return true;
    const { toolNames } = tools.data;
    if (!useOfOperations(toolNames, store, asset.name)?.writes) continue;
    for (const name of toolNames) {
      if (name.startsWith(KNOWLEDGE_OPERATION_PREFIX)) return true;
      const called = parseConnectionOperationName(name);
      if (called && (await closed(called.connection, called.operation))) return true;
    }
  }
  return false;
}
