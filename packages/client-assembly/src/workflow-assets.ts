import { checkWorkflowOwnRights, publishWorkflowOwnAccount } from "./workflow-owned-account";
import { checkWorkflowPersonContexts } from "./workflow-person-context";
import {
  getSubjectUserId,
  asUserId,
  isAuthenticatedServicePrincipal
} from "@work-shape/catalyst-core";
import { checkPublishedChildren } from "./workflow-child-assets";
import { workflowAccountRights } from "./workflow-account-rights";
import {
  createWorkflowLiveCheck,
  type PublishReach,
  type WorkflowAssetKind,
  type WorkflowRunAsOptions
} from "@work-shape/catalyst-server";
import {
  WORKFLOW_NAME_PATTERN,
  WORKFLOW_NAME_RULE,
  workflowConfigSchema
} from "@work-shape/catalyst-config-schema";
import {
  AppError,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  defineAssetKind,
  parseConnectionOperationName,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type JsonObject,
  type StorePage,
  type PlatformStores
} from "@work-shape/catalyst-core";
import {
  WORKFLOW_MANIFEST_MAX_BYTES,
  assertWorkflowPackages,
  checkChildContracts,
  childRulesRevisionWarnings,
  checkDatasetContracts,
  enqueueDatasetCleanup,
  checkChildCycles,
  indexWorkflowSteps,
  parseWorkflowManifest,
  replaceScheduleJob,
  stepFileBytes,
  workflowDefinitionRefusal,
  workflowStepFileIssues,
  workflowStepFilesRefusal,
  workflowKindIssues,
  workflowLimitIssues,
  workflowContinuationIssues,
  workflowRunPrincipal,
  resolveWorkflowNeededRights,
  type WorkflowDefinitionResult,
  type WorkflowLimitContext,
  type WorkflowDefinitionRevision,
  type WorkflowDefinitionSource,
  type WorkflowStepFile,
  type WorkflowStepFiles,
  type WorkflowRunnerPackage
} from "@work-shape/catalyst-workflows";
import { z } from "zod";
import { runnerPackageManifest } from "./runner-packages";
import { workflowPublishQuestion } from "./workflow-publish-question";

// A Workflow as an asset: the kind the asset operations register, and the published revisions
// of that kind as the engine reads its definitions. A revision's config is the id of the
// Workflow under `name`, `workflow.yaml` as an object under `manifest` and the files of its
// `steps/` folder under `files`. The files are part of the revision, as the resources of a
// skill are: one write stores both, a revision never changes, and whoever reads the revision
// reads its files.

const manifestOfConfigSchema = z.object({ manifest: z.unknown() });
const nameOfConfigSchema = z.object({ name: z.string() });
const filesOfConfigSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).optional()
});
const runAsOfConfigSchema = z.object({ manifest: z.object({ runAs: z.unknown() }) });

/** The default size of one published Workflow page; the exclusive name cursor reaches more. */
const WORKFLOW_LIST_PAGE_SIZE = 200;

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
 *
 * A publish and a delete move the job of the Workflow's schedule with them: the job of the
 * next due time is queued in the transaction of the publish, and the one of a schedule the
 * Workflow no longer has is withdrawn. The planner of a starting process queues what is
 * missing, and a job that fires for a definition without its schedule starts nothing.
 */
export function createWorkflowAssetKind(
  options: WorkflowRunAsOptions & {
    /** The time zone of the engine's schedules. UTC when left out. */
    configAssets: Pick<ConfigAssetStore, "getConfigAsset" | "listPublishedConfigAssets">;
    timeZone?: string;
    /** The installed distributions of the release runner. Empty when its manifest is missing. */
    runnerPackages?: readonly WorkflowRunnerPackage[];
    registry?: () =>
      | Pick<import("@work-shape/catalyst-core").OperationRegistry, "resolve" | "resolveMany">
      | undefined;
    /** The clock of the engine, for a test of due times. */
    now?: () => Date;
    /**
     * The ceilings of release config and the step slots, which a publish holds a Workflow's
     * `limits` to and the publish question measures a raise by.
     */
    limits: WorkflowLimitContext;
  }
): WorkflowAssetKind {
  const { clientInstanceId, timeZone = "UTC", now = () => new Date(), limits } = options;
  /** The definition of a published config as the engine runs it, or nothing where it runs none. */
  const runnable = (config: JsonObject | undefined) => {
    const parsed = parseStoredManifest(manifestOfConfigSchema.safeParse(config).data?.manifest);
    return parsed.ok ? parsed.manifest : undefined;
  };
  // The publish already owns a platform connection. Bind every sourced operation read,
  // including nested resolution by an App action, to its transaction's readers.
  const registryFor = (stores: PlatformStores) => {
    const registry = options.registry?.();
    return (
      registry && {
        resolve: (name: string) => registry.resolve(name, stores),
        resolveMany: (names: readonly string[]) => registry.resolveMany(names, stores)
      }
    );
  };
  async function reschedule(
    stores: PlatformStores,
    previous: JsonObject | undefined,
    published: JsonObject | undefined
  ): Promise<void> {
    const workflow = nameOfConfigSchema.safeParse(published ?? previous).data?.name;
    if (workflow === undefined) return;
    const before = runnable(previous);
    const next = runnable(published);
    await replaceScheduleJob(stores, {
      clientInstanceId,
      workflow,
      ...(before ? { previous: before } : {}),
      ...(next ? { published: next } : {}),
      timeZone,
      now: now()
    });
  }
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
        approve: WORKFLOW_ACTIONS.approve,
        use: WORKFLOW_ACTIONS.use
      },
      lifecycle: "draft_published",
      draftCalls: true,
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
          const files = workflowStepFileIssues(result.manifest, workflow.files ?? []);
          if (files.length > 0) throw workflowStepFilesRefusal(workflow.name, files);
        }
        return [];
      },
      summarize: (workflow) => ({
        name: workflow.name,
        title: workflow.manifest.name,
        attributes: { workflowKind: workflow.manifest.kind === "data" ? "data" : "process" },
        ...(workflow.manifest.description === undefined
          ? {}
          : { description: workflow.manifest.description })
      })
    }),
    crossOwnerReferences: ["app", "data_store", "knowledge_base"],
    references: (config) => {
      // onFailure is a declared reference even before the engine executes failure Workflows.
      // Inventory the rest through the bounded engine parser without that unsupported field.
      const raw = z
        .object({ onFailure: z.string().optional() })
        .loose()
        .safeParse(manifestOfConfigSchema.safeParse(config).data?.manifest);
      if (
        !raw.success ||
        Buffer.byteLength(JSON.stringify(raw.data), "utf8") > WORKFLOW_MANIFEST_MAX_BYTES
      )
        return [];
      const { onFailure, ...manifest } = raw.data;
      const parsed = parseStoredManifest(manifest);
      if (!parsed.ok) return [];
      const references: { kind: string; name: string }[] = [];
      const operation = (name: string) => {
        const connection = parseConnectionOperationName(name);
        if (connection) references.push({ kind: "connection", name: connection.connection });
        const match = /^(data_store|knowledge|workflow|app)\.([^.]+)\./u.exec(name);
        const kind = match?.[1];
        const asset = match?.[2];
        if (kind && asset)
          references.push({ kind: kind === "knowledge" ? "knowledge_base" : kind, name: asset });
      };
      for (const { step } of indexWorkflowSteps(parsed.manifest).values()) {
        if (step.type === "workflow")
          references.push({ kind: WORKFLOW_ASSET_KIND, name: step.workflow });
        if (step.type === "operation") operation(step.operation);
        if (step.type === "notify" && step.link?.kind === "app")
          references.push({ kind: "app", name: step.link.app });
      }
      for (const tool of parsed.manifest.tools ?? []) operation(tool);
      const failure = onFailure;
      if (failure?.startsWith("workflow."))
        references.push({ kind: WORKFLOW_ASSET_KIND, name: failure.slice("workflow.".length) });
      return references;
    },
    async readRunsAs(config) {
      const manifest = runnable(config);
      if (!manifest) return undefined;
      if (manifest.runAs === undefined) return manifest.name;
      const principal = await workflowRunPrincipal(
        options.apiAccess,
        clientInstanceId,
        manifest,
        options.configAssets
      );
      return principal?.displayLabel;
    },
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => {
      const config = z
        .object({ manifest: z.object({ steps: z.array(z.unknown()) }).loose() })
        .safeParse(next);
      if (!config.success) return next;
      const steps = config.data.manifest.steps.map((step) => {
        const trigger = z
          .object({ type: z.literal("trigger"), triggers: z.array(z.unknown()) })
          .loose()
          .safeParse(step);
        if (!trigger.success) return step;
        return {
          ...trigger.data,
          triggers: trigger.data.triggers.map((value) => {
            const schedule = z
              .object({ kind: z.literal("schedule"), timeZone: z.string().optional() })
              .loose()
              .safeParse(value);
            return schedule.success &&
              schedule.data.timeZone === undefined &&
              options.timeZone !== undefined
              ? { ...schedule.data, timeZone }
              : value;
          })
        };
      });
      return { ...next, manifest: { ...config.data.manifest, steps } };
    },
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    async onPublish({ stores, replaced, config, actor, revisionId, assetId, access }) {
      const publisher = isAuthenticatedServicePrincipal(actor)
        ? undefined
        : getSubjectUserId(actor);
      if (publisher)
        await stores.workflowNotices.recordPublisher({
          clientInstanceId,
          revisionId,
          userId: asUserId(publisher)
        });
      const parsed = workflowConfigSchema.parse(config);
      const result = parseStoredManifest(parsed.manifest);
      if (!result.ok) throw workflowDefinitionRefusal(parsed.name, result.issues);
      await publishWorkflowOwnAccount(stores, {
        clientInstanceId,
        assetId,
        manifest: result.manifest,
        actor,
        access,
        rights: await resolveWorkflowNeededRights(
          { ...options, configAssets: stores.configAssets, registry: () => registryFor(stores) },
          result.manifest
        )
      });
      const continuation = await workflowContinuationIssues(result.manifest, options.registry?.());
      if (continuation.length > 0)
        throw workflowDefinitionRefusal(result.manifest.id, continuation);
      const kindIssues = workflowKindIssues(result.manifest);
      if (kindIssues.length > 0) throw workflowDefinitionRefusal(parsed.name, kindIssues);
      // A limit above the operator's ceiling is refused here, by name, and never clamped.
      const above = workflowLimitIssues(result.manifest, limits);
      if (above.length > 0) throw workflowDefinitionRefusal(parsed.name, above);
      assertWorkflowPackages(
        result.manifest,
        options.runnerPackages ?? runnerPackageManifest.packages
      );
      // The pointer has moved in this transaction, but is not visible outside it yet.
      // Serializing graph reads here prevents two individually safe publishes forming a cycle.
      await stores.workflowRuns.lockDefinitionGraph({ clientInstanceId });
      await checkDatasetContracts(
        result.manifest,
        createWorkflowAssetDefinitions({ clientInstanceId, configAssets: stores.configAssets }),
        registryFor(stores)
      );
      await checkChildCycles(
        result.manifest,
        createWorkflowAssetDefinitions({ clientInstanceId, configAssets: stores.configAssets })
      );
      await checkWorkflowPersonContexts(
        { clientInstanceId, stores },
        result.manifest,
        createWorkflowAssetDefinitions({ clientInstanceId, configAssets: stores.configAssets })
      );
      await reschedule(stores, replaced, config);
    },
    // Account revocation is part of the delete, never a best-effort after-write task.
    async withinWrite({ stores, assetId, config }) {
      if (config !== undefined || assetId === undefined) return undefined;
      const principal = await stores.apiAccess.findServicePrincipalByOwner({
        clientInstanceId,
        owner: { kind: WORKFLOW_ASSET_KIND, assetId }
      });
      if (principal)
        await stores.apiAccess.deleteServicePrincipal({
          clientInstanceId,
          servicePrincipalId: principal.id
        });
      return undefined;
    },
    async onUnpublish({ stores, assetId, published }) {
      const principal = await stores.apiAccess.findServicePrincipalByOwner({
        clientInstanceId,
        owner: { kind: WORKFLOW_ASSET_KIND, assetId }
      });
      if (principal)
        await stores.apiAccess.deleteServicePrincipal({
          clientInstanceId,
          servicePrincipalId: principal.id
        });
      await reschedule(stores, published, undefined);
    },
    async onRemove({ stores, published, name }) {
      const parsed = workflowConfigSchema.safeParse(published);
      const workflow = name ?? (parsed.success ? parsed.data.name : undefined);
      if (workflow !== undefined) {
        await stores.workflowRunDatasets.claimWorkflow({
          clientInstanceId,
          workflow
        });
        await enqueueDatasetCleanup(
          stores,
          clientInstanceId,
          (options.now?.() ?? new Date()).toISOString()
        );
      }
      await reschedule(stores, published, undefined);
    },
    assertScopedWrite: async ({ definition, stores }) => {
      const parsed = workflowConfigSchema.parse(definition);
      const result = parseStoredManifest(parsed.manifest);
      if (!result.ok) throw workflowDefinitionRefusal(parsed.name, result.issues);
      await checkChildContracts(
        result.manifest,
        createWorkflowAssetDefinitions({ clientInstanceId, configAssets: stores.configAssets }),
        registryFor(stores)
      );
    },
    validationWarnings: async ({ definition, stores }) => {
      const parsed = parseStoredManifest(
        manifestOfConfigSchema.safeParse(definition).data?.manifest
      );
      return parsed.ok
        ? childRulesRevisionWarnings(
            parsed.manifest,
            createWorkflowAssetDefinitions({ clientInstanceId, configAssets: stores.configAssets })
          )
        : [];
    },
    publishReach: workflowPublishReach,
    // A raise of a limit above the release's default and whom a notify step reaches are named
    // before the publish, in the reader's language.
    publishQuestion: async ({ config, locale, names }) => {
      const parsed = parseStoredManifest(manifestOfConfigSchema.safeParse(config).data?.manifest);
      return parsed.ok
        ? workflowPublishQuestion({
            manifest: parsed.manifest,
            limits,
            locale,
            names,
            rights: await resolveWorkflowNeededRights(options, parsed.manifest)
          })
        : [];
    },
    // What the accounts of a publish need, for the screen that asks it before the publish.
    principalRights: (workflow) =>
      workflowAccountRights(
        options,
        createWorkflowAssetDefinitions({ clientInstanceId, configAssets: options.configAssets }),
        workflow
      ),
    async authorizeLive(input) {
      const config = workflowConfigSchema.parse(input.config);
      const result = parseStoredManifest(config.manifest);
      if (!result.ok) throw workflowDefinitionRefusal(config.name, result.issues);
      const continuation = await workflowContinuationIssues(result.manifest, options.registry?.());
      if (continuation.length > 0)
        throw workflowDefinitionRefusal(result.manifest.id, continuation);
      const kindIssues = workflowKindIssues(result.manifest);
      if (kindIssues.length > 0) throw workflowDefinitionRefusal(config.name, kindIssues);
      if (result.manifest.runAs === undefined) {
        checkWorkflowOwnRights(
          result.manifest,
          await resolveWorkflowNeededRights(options, result.manifest),
          input
        );
      } else
        await createWorkflowLiveCheck(
          options,
          (config) => runAsOfConfigSchema.safeParse(config).data?.manifest.runAs
        )(input);
      assertWorkflowPackages(
        result.manifest,
        options.runnerPackages ?? runnerPackageManifest.packages
      );
      await checkPublishedChildren(
        options,
        result.manifest,
        createWorkflowAssetDefinitions({ clientInstanceId, configAssets: options.configAssets })
      );
    }
  };
}

/**
 * What a Workflow revision reaches beside the live one: its steps that call an operation, new
 * or changed, the Connections those calls go through and the principal a run acts as.
 */
function workflowPublishReach(next: JsonObject, live: JsonObject | undefined): PublishReach {
  const manifestOf = (config: JsonObject | undefined) => {
    const parsed = parseStoredManifest(manifestOfConfigSchema.safeParse(config).data?.manifest);
    return parsed.ok ? parsed.manifest : undefined;
  };
  const stepsOf = (manifest: ReturnType<typeof manifestOf>) =>
    manifest ? [...indexWorkflowSteps(manifest).values()].map(({ step }) => step) : [];
  const manifest = manifestOf(next);
  const before = new Map(stepsOf(manifestOf(live)).map((step) => [step.id, JSON.stringify(step)]));
  const calls = stepsOf(manifest).flatMap((step) => (step.type === "operation" ? [step] : []));
  return {
    calls: calls.flatMap((step) => {
      const then = before.get(step.id);
      if (then === JSON.stringify(step)) return [];
      return [
        {
          label: step.name,
          operation: step.operation,
          change: then === undefined ? ("new" as const) : ("changed" as const)
        }
      ];
    }),
    hostsAdded: [],
    connections: [
      ...new Set(
        calls.flatMap((step) => parseConnectionOperationName(step.operation)?.connection ?? [])
      )
    ],
    dataStores: [],
    ...(manifest ? { runAs: manifest.runAs } : {})
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
  /** The step files of the revision, where it is stored with them. */
  files?: readonly WorkflowStepFile[];
}

/** The step files a stored config holds. None where it holds none or is no config of the kind. */
function stepFilesOf(config: JsonObject | null | undefined): readonly WorkflowStepFile[] {
  return filesOfConfigSchema.safeParse(config).data?.files ?? [];
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
    definition,
    files: stepFilesOf(publishedConfig)
  };
}

/**
 * The step files of the Workflow assets of one instance, read from the revision a run names.
 * A run keeps the id of the revision it was started on, and a revision never changes: the
 * script it reads is the one that revision was saved with, whatever was published since and
 * also where the Workflow was deleted since.
 */
export function createWorkflowAssetStepFiles(options: {
  clientInstanceId: ClientInstanceId;
  configAssets: Pick<ConfigAssetStore, "getConfigAssetRevisionById">;
}): WorkflowStepFiles {
  return {
    async readStepFile({ workflow, revisionId, path }) {
      if (!WORKFLOW_NAME_PATTERN.test(workflow)) return undefined;
      const revision = await options.configAssets.getConfigAssetRevisionById({
        clientInstanceId: options.clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: workflow,
        revisionId
      });
      return stepFileBytes(stepFilesOf(revision?.config), path);
    }
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
  /** One page of published Workflows, including those this engine refuses. */
  published(page?: StorePage): Promise<PublishedWorkflow[]>;
  /** The retained asset id, including drafts and deleted assets: what rights are decided on. */
  assetIdOf(id: string): Promise<string | undefined>;
  /**
   * The draft of the Workflow of this id, which a test run runs: the asset's newest revision,
   * published or not. Nothing where no asset has the id; a draft the engine cannot run is
   * refused with what is wrong with it.
   */
  draft(id: string): Promise<WorkflowDefinitionRevision | undefined>;
} {
  const { clientInstanceId, configAssets } = options;
  const published = async (page: StorePage = { limit: WORKFLOW_LIST_PAGE_SIZE }) =>
    (
      await configAssets.listPublishedConfigAssets({
        clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        limit: page.limit,
        ...(typeof page.after?.[0] === "string" ? { afterName: page.after[0] } : {})
      })
    ).flatMap((asset) => publishedWorkflowOf(asset) ?? []);
  const assetOf = (id: string, reader: Pick<ConfigAssetStore, "getConfigAsset"> = configAssets) =>
    // An id that is no name of the kind is no asset, and is not asked of the store.
    WORKFLOW_NAME_PATTERN.test(id)
      ? reader.getConfigAsset({ clientInstanceId, kind: WORKFLOW_ASSET_KIND, name: id })
      : Promise.resolve(undefined);
  return {
    published,
    async assetIdOf(id) {
      const asset = await assetOf(id);
      // Deletion retains the row and its grants; retained runs keep the same deny boundary.
      return asset?.id;
    },
    async draft(id) {
      const asset = await assetOf(id);
      if (asset?.status !== "active") return undefined;
      const parsed = parseStoredManifest(
        manifestOfConfigSchema.safeParse(asset.config).data?.manifest
      );
      if (!parsed.ok) throw workflowDefinitionRefusal(id, parsed.issues);
      // A save refuses a manifest of another id, so this is a row nothing of the product wrote.
      if (parsed.manifest.id !== asset.name) {
        throw new AppError("CONFLICT", `The draft of '${id}' names another id`, {
          reason: "definition_invalid"
        });
      }
      return { revisionId: asset.activeRevisionId, manifest: parsed.manifest };
    },
    async readSchedules(id) {
      const asset = await assetOf(id);
      if (asset?.status !== "active" || asset.publishedConfig === undefined) return [];
      const parsed = z
        .object({ manifest: z.object({ steps: z.array(z.unknown()) }) })
        .safeParse(asset.publishedConfig);
      const trigger = z
        .object({ type: z.literal("trigger"), triggers: z.array(z.unknown()) })
        .safeParse(parsed.data?.manifest.steps[0]);
      return (trigger.data?.triggers ?? []).flatMap((value) => {
        const schedule = z
          .object({
            kind: z.literal("schedule"),
            cron: z.string(),
            timeZone: z.string().optional()
          })
          .safeParse(value);
        return schedule.success ? [schedule.data] : [];
      });
    },
    async read(id, configAssets) {
      const asset = await assetOf(id, configAssets);
      const workflow = asset ? publishedWorkflowOf(asset) : undefined;
      if (!workflow) return undefined;
      if (!workflow.definition.ok) throw workflowDefinitionRefusal(id, workflow.definition.issues);
      return { revisionId: workflow.revisionId, manifest: workflow.definition.manifest };
    },
    async list(page) {
      return (await published(page)).map(({ id, name, description, definition }) => ({
        kind: definition.ok ? (definition.manifest.kind ?? "process") : "process",
        id,
        name,
        ...(description === undefined ? {} : { description })
      }));
    }
  };
}

/** The published revisions of a source that is asked one Workflow at a time, such as a folder. */
export async function publishedWorkflowsOf(
  source: WorkflowDefinitionSource,
  page?: StorePage
): Promise<PublishedWorkflow[]> {
  const published: PublishedWorkflow[] = [];
  for (const summary of await source.list(page)) {
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
