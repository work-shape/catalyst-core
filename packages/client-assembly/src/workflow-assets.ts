import {
  checkWorkflowOwnRights,
  publishWorkflowOwnAccount,
  type WorkflowOwnRightsModules
} from "./workflow-owned-account";
import { checkWorkflowPersonContexts } from "./workflow-person-context";
import {
  getSubjectUserId,
  asUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity
} from "@work-shape/catalyst-core";
import { checkPublishedChildren } from "./workflow-child-assets";
import { workflowAccountRights } from "./workflow-account-rights";
import {
  createWorkflowLiveCheck,
  mailSendStepRefusal,
  workflowLiveCallerWarnings,
  type PublishReach,
  type WorkflowAssetKind,
  type WorkflowAssetRef,
  type WorkflowRunAsOptions
} from "@work-shape/catalyst-server";
import {
  WORKFLOW_NAME_PATTERN,
  WORKFLOW_NAME_RULE,
  workflowConfigSchema
} from "@work-shape/catalyst-config-schema";
import {
  ASSET_OWNER_KINDS,
  AppError,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  defineAssetKind,
  enqueueKnowledgeWorkflowSourceEnd,
  parseConnectionOperationName,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore,
  type JsonObject,
  type StorePage,
  type PlatformStores,
  type WorkflowManifest
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
  parseCron,
  nextDueAfter,
  stepFileBytes,
  workflowDefinitionRefusal,
  workflowOutsideIssues,
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
  type WorkflowEngine,
  type WorkflowRunnerPackage
} from "@work-shape/catalyst-workflows";
import { z } from "zod";
import { runnerPackageManifest } from "./runner-packages";
import { workflowPublishQuestion } from "./workflow-publish-question";
import { WORKFLOW_REVISION_FILES } from "./workflow-folder";

// A Workflow as an asset: the kind the asset operations register, and the published revisions
// of that kind as the engine reads its definitions. A revision's config is the id of the
// Workflow under `name`, `workflow.yaml` as an object under `manifest` and the files of its
// `steps/` folder under `files`. The files are part of the revision, as the resources of a
// skill are: one write stores both, a revision never changes, and whoever reads the revision
// reads its files. Every write also keeps that folder as a file set and, where the Workflow
// has a repository, commits it there (WF-GIT-1); the config stays what everything reads.

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
 * instance or by one workspace (WS-OWN-1b). A write moves the draft and starts nothing. Both a write and a publish ask the
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
    /** The modules of the instance: a right of a kind whose module is off is refused. */
    modules?: WorkflowOwnRightsModules;
    /**
     * Whether the instance has `mail.send` and whom it may mail: a save and a publish refuse a
     * step on it where it is missing, and a literal recipient outside the rule.
     */
    mailSend?: { registered: boolean; recipientDomains: readonly string[] };
    /**
     * The ceilings of release config and the step slots, which a publish holds a Workflow's
     * `limits` to and the publish question measures a raise by.
     */
    limits: WorkflowLimitContext;
    /**
     * The runs of the instance, once its engine is built: retiring a Workflow with its
     * workspace cancels its open runs there. None in a process without an engine.
     */
    runs?: () => Pick<WorkflowEngine, "cancelOpenRuns"> | undefined;
    /**
     * Whether the instance has Knowledge Bases a Workflow may feed: a delete then ends the
     * Workflow's source in each, in its transaction (KBW-2c).
     */
    knowledgeSources?: boolean;
    /**
     * Whether every write is a commit of the Workflow's folder (WF-GIT-1): where the instance
     * keeps files and runs the worker that commits. Without it a Workflow is written as its
     * config alone, as before.
     */
    repository?: boolean;
  }
): WorkflowAssetKind {
  const { clientInstanceId, timeZone = "UTC", now = () => new Date(), limits } = options;
  /** The definition of a published config as the engine runs it, or nothing where it runs none. */
  const runnable = (config: JsonObject | undefined) => {
    const parsed = parseStoredManifest(manifestOfConfigSchema.safeParse(config).data?.manifest);
    return parsed.ok ? parsed.manifest : undefined;
  };
  const assertMailSteps = async (
    manifest: WorkflowManifest,
    stores: PlatformStores,
    actor: AuthenticatedIdentity
  ) => {
    const refusal = await mailSendStepRefusal(manifest, {
      clientInstanceId,
      stores,
      author: isAuthenticatedServicePrincipal(actor) ? undefined : getSubjectUserId(actor),
      registered: options.mailSend?.registered ?? false,
      recipientDomains: options.mailSend?.recipientDomains ?? []
    });
    if (refusal) throw refusal;
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
  /**
   * Queues the end of the deleted Workflow's sources in every Knowledge Base it fed: those of
   * the revisions up to its last, and none of a Workflow created later under its name.
   */
  async function endKnowledgeSources(
    stores: PlatformStores,
    workflow: string,
    through: number,
    correlationId: string
  ): Promise<void> {
    if (!options.knowledgeSources) return;
    await enqueueKnowledgeWorkflowSourceEnd(stores.jobs, {
      clientInstanceId,
      workflow,
      through,
      correlationId
    });
  }
  /** Retires the Workflow's principal with its grants: a Workflow that is not live acts as nobody. */
  async function retirePrincipal(stores: PlatformStores, assetId: string): Promise<void> {
    const principal = await stores.apiAccess.findServicePrincipalByOwner({
      clientInstanceId,
      owner: { kind: WORKFLOW_ASSET_KIND, assetId }
    });
    if (principal)
      await stores.apiAccess.deleteServicePrincipal({
        clientInstanceId,
        servicePrincipalId: principal.id
      });
  }
  /** Hands the datasets of a deleted Workflow's runs to their cleanup. */
  async function releaseDatasets(stores: PlatformStores, workflow: string): Promise<void> {
    await stores.workflowRunDatasets.claimWorkflow({ clientInstanceId, workflow });
    await enqueueDatasetCleanup(stores, clientInstanceId, now().toISOString());
  }
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
      // A workspace owns the Workflows made in it, as it owns its agents and Apps (WS-OWN-1b).
      owners: [...ASSET_OWNER_KINDS],
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
      // Every write is a commit of the Workflow's folder in its own repository (WF-GIT-1).
      ...(options.repository ? { content: "repository" as const } : {}),
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
    readSchedule(config) {
      const manifest = runnable(config);
      const trigger = manifest?.steps[0];
      const schedules =
        trigger?.type === "trigger"
          ? trigger.triggers.filter((entry) => entry.kind === "schedule")
          : [];
      const crons = schedules.flatMap((entry) => {
        const parsed = parseCron(entry.cron);
        return parsed ? [{ ...parsed, timeZone: entry.timeZone }] : [];
      });
      const next = nextDueAfter(crons, now(), timeZone);
      return {
        timeZone: schedules[0]?.timeZone ?? timeZone,
        ...(next ? { nextDueAt: next.toISOString() } : {})
      };
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
        ...(options.modules ? { modules: options.modules } : {}),
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
      await assertMailSteps(result.manifest, stores, actor);
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
      // Started from outside, it may read only what is exposed to outside (named here; asked
      // again at every start, since a Connection or a child changes after this publish).
      const outside = await workflowOutsideIssues(result.manifest, {
        clientInstanceId,
        configAssets: stores.configAssets,
        definitions: createWorkflowAssetDefinitions({
          clientInstanceId,
          configAssets: stores.configAssets
        })
      });
      if (outside.length > 0) throw workflowDefinitionRefusal(result.manifest.id, outside);
      await reschedule(stores, replaced, config);
    },
    // Account revocation is part of the delete, never a best-effort after-write task.
    // So is the end of its sources in the Knowledge Bases it fed (KBW-2c).
    async withinWrite({ stores, assetId, config, name, previousRevision, correlationId }) {
      if (config !== undefined || assetId === undefined) return undefined;
      await retirePrincipal(stores, assetId);
      if (previousRevision !== undefined)
        await endKnowledgeSources(stores, name, previousRevision, correlationId);
      return undefined;
    },
    // Written as its config or as its whole folder, read as either (WF-GIT-1).
    ...(options.repository ? { revisionFiles: WORKFLOW_REVISION_FILES } : {}),
    // The live Apps that start it stop working without it: an unpublish and a delete say so.
    liveCallerWarnings: workflowLiveCallerWarnings,
    async onUnpublish({ stores, assetId, published }) {
      await retirePrincipal(stores, assetId);
      await reschedule(stores, published, undefined);
    },
    async onRemove({ stores, published, name }) {
      const parsed = workflowConfigSchema.safeParse(published);
      const workflow = name ?? (parsed.success ? parsed.data.name : undefined);
      if (workflow !== undefined) await releaseDatasets(stores, workflow);
      await reschedule(stores, published, undefined);
    },
    // A workspace's Workflows go with it by the delete above, in one transaction, and their
    // open runs end (WS-OWN-1b). The store then keeps each name taken as the instance's.
    async retireWithWorkspace({ assets, stores, actor, correlationId }) {
      const cancelOpen = async () => {
        const runs = options.runs?.();
        for (const asset of assets)
          await runs?.cancelOpenRuns({ workflow: asset.name, actor, correlationId });
      };
      await cancelOpen();
      await stores.transaction(async (tx) => {
        const current: ConfigAssetRecord[] = [];
        for (const asset of assets) {
          const stored = await tx.configAssets.getConfigAsset({
            clientInstanceId,
            kind: WORKFLOW_ASSET_KIND,
            name: asset.name
          });
          if (stored?.status === "active" && stored.id === asset.id) current.push(stored);
        }
        if (current.length === 0) return;
        const key = (name: string) => `${WORKFLOW_ASSET_KIND}:${name}`;
        await tx.configAssets.applyConfigAssetMutations({
          clientInstanceId,
          actor,
          baseRevisions: Object.fromEntries(
            current.map((asset) => [key(asset.name), asset.revision])
          ),
          baseAssetIds: Object.fromEntries(current.map((asset) => [key(asset.name), asset.id])),
          mutations: current.map((asset) => ({
            type: "delete" as const,
            kind: WORKFLOW_ASSET_KIND,
            name: asset.name,
            scope: asset.scope
          }))
        });
        for (const asset of current) {
          await retirePrincipal(tx, asset.id);
          await endKnowledgeSources(tx, asset.name, asset.revision, correlationId);
          await releaseDatasets(tx, asset.name);
          await reschedule(tx, asset.publishedConfig, undefined);
          await tx.audit.appendAuditEvent({
            clientInstanceId,
            type: "config_asset.deleted",
            status: "success",
            actor,
            correlationId,
            metadata: {
              kind: WORKFLOW_ASSET_KIND,
              name: asset.name,
              revision: asset.revision,
              requestedBy: "workspace_deletion"
            }
          });
        }
      });
      // A run that started meanwhile, before the delete took the published revision away.
      await cancelOpen();
    },
    assertScopedWrite: async ({ definition, stores, actor }) => {
      const parsed = workflowConfigSchema.parse(definition);
      const result = parseStoredManifest(parsed.manifest);
      if (!result.ok) throw workflowDefinitionRefusal(parsed.name, result.issues);
      await assertMailSteps(result.manifest, stores, actor);
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
    // What the accounts of a publish need, for the screen that asks it before the publish, and
    // for the publish review of the revision it reads.
    principalRights: (workflow, config) => {
      const definitions = createWorkflowAssetDefinitions({
        clientInstanceId,
        configAssets: options.configAssets
      });
      if (config === undefined) return workflowAccountRights(options, definitions, workflow);
      const parsed = parseStoredManifest(manifestOfConfigSchema.safeParse(config).data?.manifest);
      return parsed.ok
        ? workflowAccountRights(options, definitions, workflow, parsed.manifest)
        : Promise.resolve(undefined);
    },
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
          input,
          options.modules
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
  /** The asset that holds it, where it is stored as one: its id and its owner. */
  asset?: WorkflowAssetRef;
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
    asset: { id: asset.id, scope: asset.scope },
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
  assetOf(id: string): Promise<WorkflowAssetRef | undefined>;
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
    async assetOf(id) {
      const asset = await assetOf(id);
      // Deletion retains the row and its grants; retained runs keep the same deny boundary.
      return asset && { id: asset.id, scope: asset.scope };
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
