import {
  createWorkflowLiveCheck,
  type WorkflowAssetKind,
  type WorkflowRunAsOptions
} from "@vivd-catalyst/chat-server";
import {
  WORKFLOW_NAME_PATTERN,
  WORKFLOW_NAME_RULE,
  workflowConfigSchema
} from "@vivd-catalyst/config-schema";
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  defineAssetKind,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import {
  WORKFLOW_MANIFEST_MAX_BYTES,
  parseWorkflowManifest,
  workflowDefinitionRefusal,
  type WorkflowDefinitionResult,
  type WorkflowDefinitionSource
} from "@vivd-catalyst/workflows";
import { z } from "zod";

// A Workflow as an asset: the kind the asset operations register, and the published revisions
// of that kind as the engine reads its definitions. A revision's config is the id of the
// Workflow under `name` and `workflow.yaml` as an object under `manifest`.

const manifestOfConfigSchema = z.object({ manifest: z.unknown() });
const runAsOfConfigSchema = z.object({ manifest: z.object({ runAs: z.unknown() }) });

/**
 * How many published Workflows one list of the instance reads. The list has no pages, so this
 * is the bound of its one read.
 */
export const WORKFLOW_LIST_MAX = 500;

/** How much of a Workflow's name and of its description one entry of the list carries. */
export const WORKFLOW_LIST_NAME_MAX = 200;
export const WORKFLOW_LIST_DESCRIPTION_MAX = 500;

/**
 * A stored manifest read as the engine reads `workflow.yaml`: held to the bound of the file,
 * measured as JSON, then parsed. Every run copies its definition, so one over the bound is no
 * definition, at a save, at a publish and where an earlier release stored it.
 */
function parseStoredManifest(manifest: unknown): WorkflowDefinitionResult {
  const bytes = Buffer.byteLength(JSON.stringify(manifest) ?? "", "utf8");
  if (bytes > WORKFLOW_MANIFEST_MAX_BYTES) {
    return {
      ok: false,
      issues: [
        {
          path: "",
          message: `The definition is larger than ${WORKFLOW_MANIFEST_MAX_BYTES} bytes`
        }
      ]
    };
  }
  return parseWorkflowManifest(manifest);
}

/**
 * The Workflow kind: one definition with a draft and a published revision, owned by the
 * instance. A write moves the draft and starts nothing. Both a write and a publish ask the
 * engine's own parser, so a definition the engine refuses is refused there with the engine's
 * code as the reason. A publish also asks whether its caller may let a Workflow act as the
 * service principal the revision names. A release does not carry the kind: it is written by
 * its own rights through the asset operations.
 */
export function createWorkflowAssetKind(options: WorkflowRunAsOptions): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: WORKFLOW_ASSET_KIND,
      plural: "workflows",
      schema: workflowConfigSchema,
      nameRule: { pattern: WORKFLOW_NAME_PATTERN, description: WORKFLOW_NAME_RULE },
      actions: {
        read: WORKFLOW_ACTIONS.read,
        write: WORKFLOW_ACTIONS.write,
        delete: WORKFLOW_ACTIONS.delete,
        publish: WORKFLOW_ACTIONS.publish,
        use: WORKFLOW_ACTIONS.use
      },
      lifecycle: "draft_published",
      validate: () => [],
      // Asked of the Workflows a write adds or changes only, and of the revision a publish
      // names: a stored definition an earlier engine accepted never stands in the way of a
      // write to another asset. The list of Workflows says of such a one why it does not run.
      validateWrite(context, workflows) {
        for (const workflow of workflows) {
          if (!context.changes(WORKFLOW_ASSET_KIND, workflow.name)) continue;
          const result = parseStoredManifest(workflow.manifest);
          if (!result.ok) throw workflowDefinitionRefusal(workflow.name, result.issues);
          if (result.manifest.id !== workflow.name) {
            return [
              {
                message: `The definition names the id '${result.manifest.id}' and is stored as the Workflow '${workflow.name}'. The two are the same`,
                path: ["manifest", "id"]
              }
            ];
          }
        }
        return [];
      },
      summarize: (workflow) => ({
        name: workflow.name,
        title: workflow.manifest.name,
        ...(workflow.manifest.description === undefined
          ? {}
          : { description: workflow.manifest.description })
      })
    }),
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    authorizeLive: createWorkflowLiveCheck(
      options,
      (config) => runAsOfConfigSchema.safeParse(config).data?.manifest.runAs
    )
  };
}

/** One published revision as the store holds it, read with the engine's parser. */
export interface PublishedWorkflow {
  id: string;
  /** The id of the asset that holds it, where it is stored as one. */
  assetId?: string;
  name: string;
  description?: string;
  /** The id of the published revision. A run started on it keeps it to its end. */
  revisionId: string;
  /** The definition, or what the engine of this release refuses of it. */
  definition: WorkflowDefinitionResult;
}

function publishedWorkflowOf(asset: ConfigAssetRecord): PublishedWorkflow | undefined {
  const { publishedRevisionId: revisionId, publishedConfig } = asset;
  if (asset.status !== "active" || revisionId === undefined || publishedConfig === undefined) {
    return undefined;
  }
  const config = workflowConfigSchema.safeParse(publishedConfig);
  const parsed = parseStoredManifest(
    manifestOfConfigSchema.safeParse(publishedConfig).data?.manifest
  );
  // The asset is addressed by its name whatever the manifest says. A save refuses a manifest
  // of another id, so this is a row nothing of the product wrote.
  const definition: WorkflowDefinitionResult =
    parsed.ok && parsed.manifest.id !== asset.name
      ? {
          ok: false,
          issues: [
            {
              path: "id",
              message: `The definition names the id '${parsed.manifest.id}' and is stored as the Workflow '${asset.name}'`
            }
          ]
        }
      : parsed;
  const shown = definition.ok ? definition.manifest : config.data?.manifest;
  return {
    id: asset.name,
    assetId: asset.id,
    name: (shown?.name ?? asset.name).slice(0, WORKFLOW_LIST_NAME_MAX),
    ...(shown?.description === undefined
      ? {}
      : { description: shown.description.slice(0, WORKFLOW_LIST_DESCRIPTION_MAX) }),
    revisionId,
    definition
  };
}

/**
 * The published revisions of the Workflow assets of one instance as the engine's definitions.
 * A draft, an asset that was never published and a deleted one are no Workflow here: nothing
 * of them is listed and nothing starts. The id of a revision is the id of the asset's
 * revision, so a run names the revision the asset operations show.
 */
export function createWorkflowAssetDefinitions(options: {
  clientInstanceId: ClientInstanceId;
  configAssets: Pick<ConfigAssetStore, "getConfigAsset" | "listPublishedConfigAssets">;
}): WorkflowDefinitionSource & {
  /** Every published Workflow in one read, those this engine refuses among them. */
  published(): Promise<PublishedWorkflow[]>;
  /** The id of the asset of this name, a draft included: what a right on it is decided on. */
  assetIdOf(id: string): Promise<string | undefined>;
} {
  const { clientInstanceId, configAssets } = options;
  const published = async () =>
    (
      await configAssets.listPublishedConfigAssets({
        clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        limit: WORKFLOW_LIST_MAX
      })
    ).flatMap((asset) => publishedWorkflowOf(asset) ?? []);
  const assetOf = (id: string) =>
    // An id that is no name of the kind is no asset, and is not asked of the store.
    WORKFLOW_NAME_PATTERN.test(id)
      ? configAssets.getConfigAsset({ clientInstanceId, kind: WORKFLOW_ASSET_KIND, name: id })
      : Promise.resolve(undefined);
  return {
    published,
    async assetIdOf(id) {
      const asset = await assetOf(id);
      return asset?.status === "active" ? asset.id : undefined;
    },
    async read(id) {
      const asset = await assetOf(id);
      const workflow = asset ? publishedWorkflowOf(asset) : undefined;
      if (!workflow) return undefined;
      if (!workflow.definition.ok) throw workflowDefinitionRefusal(id, workflow.definition.issues);
      return { revisionId: workflow.revisionId, manifest: workflow.definition.manifest };
    },
    async list() {
      return (await published()).map(({ id, name, description }) => ({
        id,
        name,
        ...(description === undefined ? {} : { description })
      }));
    }
  };
}

/** The published revisions of a source that is asked one Workflow at a time, such as a folder. */
export async function publishedWorkflowsOf(
  source: WorkflowDefinitionSource
): Promise<PublishedWorkflow[]> {
  const published: PublishedWorkflow[] = [];
  for (const summary of await source.list()) {
    const revision = await source.read(summary.id);
    if (!revision) continue;
    published.push({
      ...summary,
      revisionId: revision.revisionId,
      definition: { ok: true, manifest: revision.manifest }
    });
  }
  return published;
}
