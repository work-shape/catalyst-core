import { compiledActionsOf, declaredDataStoresOf } from "@work-shape/catalyst-app-build";
import {
  APP_ASSET_KIND,
  type AppPublishReview,
  type AppTryActionResult,
  workflowRunSchema
} from "@work-shape/catalyst-api-contract";
import {
  AppError,
  DATA_STORE_ASSET_KIND,
  WORKFLOW_ACTIONS,
  appReachesDataStore,
  appWorkflowRefusalError,
  assetPagePath,
  dataStoreRefusalError,
  isAppError,
  isAuthenticatedServicePrincipal,
  isOutsideCall,
  type ActorAccess,
  type AssetScope,
  type AuthenticatedIdentity,
  type ConfigAssetRecord,
  type JsonObject,
  type OperationAuthorization,
  type OperationExecutionContext,
  type OperationOrigin,
  type OperationTarget
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { accessResource, decide } from "../assets/asset-access";
import { AssetWorkflow } from "../assets/asset-service";
import type { ResolvedChatServerOptions } from "../types";
import type { AppActionCalls } from "./action-call";
import { appWorkflowClosure, assetTitle, storeMigrationsOf, workflowPending } from "./app-closure";
import { APP_ACTIONS, appWorkflowInputMisfit } from "./app-kind";
import type { AppWorkflow } from "./app-service";

// What an agent does with an App's draft before the person publishes it (DP-2): it tries an
// action as the draft's button does, and reads what publishing the draft would come to. Both
// ask the person's right to write the App, and an agent reaches only the conversation's subject
// App or one the conversation created. Spec: platform-access.md, Building everything from chat.

type Refusal = AppPublishReview["app"]["refusals"][number];
type ReviewItem = AppPublishReview["app"];

/** Why a service principal or an API key is refused a try of an App's draft. */
const TRY_NEEDS_A_PERSON =
  "Trying an App's draft needs a person signed in to the app; API keys cannot use it";

/** What the review calls an asset of each kind in a sentence. */
const KIND_NOUNS: Readonly<Record<string, string>> = {
  [APP_ASSET_KIND]: "App",
  [DATA_STORE_ASSET_KIND]: "Data Store"
};

/** The path of an asset's page, as an entry of the review names it. */
function withHref(asset: { kind: string; name: string; workspaceId?: string }): {
  href?: string;
} {
  const href = assetPagePath(asset);
  return href === undefined ? {} : { href };
}

/** How many of a Workflow's newest runs the review looks through for its last test run. */
const RECENT_RUNS_READ = 50;

export class AppDraftTries {
  private readonly options: ResolvedChatServerOptions;
  private readonly apps: AppWorkflow;
  private readonly actions: AppActionCalls;
  private readonly assets: AssetWorkflow;

  constructor(
    options: ResolvedChatServerOptions,
    parts: { apps: AppWorkflow; actions: AppActionCalls }
  ) {
    this.options = options;
    this.apps = parts.apps;
    this.actions = parts.actions;
    this.assets = new AssetWorkflow(options);
  }

  /** A person's right to write the App, and for an agent, an App it may try. */
  async authorize(
    caller: { access: ActorAccess; actor: AuthenticatedIdentity; origin: OperationOrigin },
    app: string
  ): Promise<OperationAuthorization> {
    if (
      isAuthenticatedServicePrincipal(caller.actor) ||
      isOutsideCall(caller.actor, caller.origin)
    ) {
      // A key cannot call an App action: what the action reads would leave the instance
      // through an operation that is exposed to Apps, not to outside clients.
      return { allowed: false, reason: "user_only", message: TRY_NEEDS_A_PERSON };
    }
    const asset = await this.app(app);
    const decision = decide(
      caller.access,
      APP_ACTIONS.write,
      accessResource(APP_ASSET_KIND, app, asset?.scope ?? { kind: "instance" }, asset?.id)
    );
    if (decision.allowed) await this.requireSubject(app, caller.origin);
    return decision;
  }

  /**
   * One action of the App's draft, called as its button calls it: the same frame session,
   * draft context and answer, with the agent's conversation in the run's origin. A `workflow`
   * action answers the test run it started and which revision of the Workflow runs.
   */
  async tryAction(
    context: OperationExecutionContext,
    input: { app: string; action: string; input: Record<string, unknown> }
  ): Promise<AppTryActionResult> {
    const { actor, access, origin } = context;
    if (isAuthenticatedServicePrincipal(actor) || isOutsideCall(actor, origin)) {
      throw new AppError(
        "FORBIDDEN",
        TRY_NEEDS_A_PERSON,
        { reason: "user_only" },
        { exposeMessage: true }
      );
    }
    await this.requireSubject(input.app, origin);
    const caller = { user: actor, access };
    const framed = await this.actions.session(
      caller,
      await this.apps.draftProof(caller, input.app)
    );
    const session =
      origin.kind === "agent" ? { ...framed, conversationId: origin.conversationId } : framed;
    let ran: { id: string; target: OperationTarget } | undefined;
    const answer = await this.actions.callAction(session, input.action, input.input, {
      correlationId: context.correlationId,
      // A repeated try is the same call of the draft.
      idempotencyKey: `try:${context.runId}`,
      header: () => undefined,
      ran: (run) => {
        ran = run;
      }
    });
    const reference = ran ? { operationRunId: ran.id, target: ran.target } : {};
    if (answer.status === "dry_run") {
      return { ...reference, status: "dry_run", message: answer.message, result: answer.result };
    }
    const action = session.actions.find((candidate) => candidate.name === input.action);
    const started =
      action?.kind === "workflow" && answer.status === "done"
        ? workflowRunSchema.safeParse(answer.result).data
        : undefined;
    if (started) {
      const run = await this.actions.workflowRun(session, started.id, context.correlationId);
      return {
        ...reference,
        status: "done",
        workflowRun: {
          runId: run.id,
          workflow: run.workflow,
          status: run.status,
          revision: run.workflowRevision ?? { kind: "draft" }
        }
      };
    }
    return {
      ...reference,
      status: answer.status,
      ...(answer.result === undefined ? {} : { result: answer.result })
    };
  }

  /**
   * What publishing the App's draft comes to, for the person who would click Publish: the App
   * and each Workflow its draft's `workflow` actions call, with what is pending, the sentence
   * of each publish question and what would refuse each publish now. It changes nothing.
   */
  async publishReview(context: OperationExecutionContext, app: string): Promise<AppPublishReview> {
    const row = await this.app(app);
    if (row?.status !== "active") throw new AppError("NOT_FOUND", "App is not available");
    const { item, config } = await this.item(context, row);
    const calls = new Map<string, string[]>();
    for (const action of compiledActionsOf(config?.manifest)) {
      if (action.kind !== "workflow") continue;
      calls.set(action.workflow, [...(calls.get(action.workflow) ?? []), action.name]);
    }
    // Every Workflow the App reaches, its children through the revision of each that will be
    // live: the draft, which one Publish of the App makes live with it, or the published one.
    const closure = config
      ? await appWorkflowClosure(this.options, { scope: row.scope, config }, (asset) =>
          workflowPending(asset) ? (asset.config ?? undefined) : asset.publishedConfig
        )
      : [];
    const workflows: AppPublishReview["workflows"] = [];
    for (const { name, asset } of closure) {
      if (!asset) {
        item.refusals.push(refusalOf(appWorkflowRefusalError("workflow_unavailable", name)));
        continue;
      }
      const read = await this.item(context, asset);
      const actions = calls.get(name) ?? [];
      // Its runs are read with the right to read the Workflow, as `workflows.list_runs` asks.
      const lastTestRun = context.access.authorize(WORKFLOW_ACTIONS.read, resourceOf(asset)).allowed
        ? await this.lastTestRun(name)
        : undefined;
      workflows.push({ ...read.item, actions, ...(lastTestRun ? { lastTestRun } : {}) });
      if (actions.length === 0) continue;
      if (!context.access.authorize(WORKFLOW_ACTIONS.use, resourceOf(asset)).allowed) {
        item.refusals.push({
          reason: "no_grant",
          right: WORKFLOW_ACTIONS.use,
          message: `Publishing the App asks your right to use the Workflow '${name}', which its actions start.`
        });
      }
      const live = read.item.pending ? read.config : asset.publishedConfig;
      for (const action of compiledActionsOf(config?.manifest)) {
        if (action.kind !== "workflow" || action.workflow !== name) continue;
        const misfit = appWorkflowInputMisfit(action, live);
        if (misfit) item.refusals.push(refusalOf(misfit));
      }
    }
    const dataStores = config
      ? await this.reviewStores(context, { scope: row.scope, config }, item)
      : [];
    return {
      app: item,
      workflows,
      dataStores,
      publishesTogether: true,
      ready: [item, ...workflows, ...dataStores].every(({ refusals }) => refusals.length === 0)
    };
  }

  /**
   * The Data Stores the App's draft binds whose draft is not published (GOLIVE-1), as one
   * Publish of the App would publish them, and those live whose migrations have not reached
   * the level the App asks yet, which it waits for: each with its live level, the level the App
   * asks of it and the migrations its draft would apply. A store whose draft does not reach that level
   * either is refused, on its own line where it is pending and on the App's where it is not.
   * Each is read with the reader's right to read it, as a Workflow is.
   */
  private async reviewStores(
    context: OperationExecutionContext,
    app: { scope: AssetScope; config: JsonObject },
    appItem: ReviewItem
  ): Promise<AppPublishReview["dataStores"]> {
    const { clientInstanceId, configAssets, stores } = this.options;
    const reviewed: AppPublishReview["dataStores"] = [];
    for (const { name, minSchema } of declaredDataStoresOf(app.config.manifest)) {
      const asset = await configAssets.store.getConfigAsset({
        clientInstanceId,
        kind: DATA_STORE_ASSET_KIND,
        name
      });
      // The App's own publish refuses a store that is not there for it.
      if (asset?.status !== "active" || !appReachesDataStore(app.scope, asset.scope)) continue;
      const { item, config } = await this.item(context, asset);
      const liveLevel =
        (await stores.dataStores.getDataStore({ clientInstanceId, id: asset.id }))?.level ?? 0;
      const draft = storeMigrationsOf(config);
      if (config && minSchema !== undefined && draft.level < minSchema) {
        const refusal = refusalOf(
          dataStoreRefusalError("data_store_draft_below_min_schema", name, {
            title: item.title,
            minSchema,
            level: draft.level
          })
        );
        (item.pending ? item.refusals : appItem.refusals).push(refusal);
      }
      // A live store an earlier Publish left below the level the App needs is listed too:
      // the Publish waits for its migrations and does not name it.
      const migrating =
        !item.pending &&
        item.refusals.length === 0 &&
        minSchema !== undefined &&
        liveLevel < minSchema &&
        draft.level >= minSchema;
      if (!item.pending && !migrating) continue;
      reviewed.push({
        ...item,
        liveLevel,
        ...(minSchema === undefined ? {} : { minSchema }),
        pendingMigrations: [...draft.migrations]
          .filter(([number]) => number > liveLevel)
          .sort(([a], [b]) => a - b)
          .map(([, migration]) => migration)
      });
    }
    return reviewed;
  }

  /**
   * The newest test run among a Workflow's recent runs: one page of its runs, newest first.
   */
  private async lastTestRun(workflow: string) {
    const runs = await this.options.stores.workflowRuns.listRuns({
      clientInstanceId: this.options.clientInstanceId,
      workflow,
      page: { limit: RECENT_RUNS_READ }
    });
    const run = runs.find((candidate) => candidate.mode === "test");
    return run && { runId: run.id, status: run.status, at: run.finishedAt ?? run.createdAt };
  }

  /** An App's row, wherever it stands. */
  private app(name: string) {
    return this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: APP_ASSET_KIND,
      name
    });
  }

  /**
   * One asset of the review: its draft and published revisions, its publish question's
   * sentence, and what would refuse its publish now. A draft that holds nothing new asks no
   * publish.
   */
  private async item(
    context: OperationExecutionContext,
    row: ConfigAssetRecord
  ): Promise<{ item: ReviewItem; config: JsonObject | undefined }> {
    const address = {
      kind: row.kind,
      name: row.name,
      ...(row.scope.kind === "workspace" ? { workspaceId: row.scope.workspaceId } : {})
    };
    const base = { name: row.name, title: row.name, draftRevision: row.revision };
    let read: Awaited<ReturnType<AssetWorkflow["reads"]["get"]>>;
    try {
      read = await this.assets.reads.get(context, { ...address, revision: "draft" });
    } catch (error) {
      return {
        item: { ...base, pending: false, refusals: [refusalOf(error)] },
        config: undefined
      };
    }
    const publishedRevision = read.publishedRevision;
    const draftRevision = row.revision;
    const pending = publishedRevision === undefined || publishedRevision !== draftRevision;
    const refusals: Refusal[] = [];
    if (pending) {
      try {
        const right = await this.assets.authorizePublish(context, {
          ...address,
          revision: draftRevision
        });
        if (!right.allowed) {
          refusals.push({
            reason: right.reason ?? "no_grant",
            message:
              right.message ??
              `You may not publish the ${KIND_NOUNS[row.kind] ?? "Workflow"} '${row.name}'.`,
            ...(right.action === undefined ? {} : { right: right.action })
          });
        }
      } catch (error) {
        refusals.push(refusalOf(error));
      }
    }
    const lastChangedBy = (
      await this.options.configAssets.store.getConfigAssetRevision({
        clientInstanceId: this.options.clientInstanceId,
        kind: row.kind,
        name: row.name,
        revision: draftRevision
      })
    )?.actor?.displayLabel;
    return {
      item: {
        ...base,
        title: assetTitle(read.config, row.name),
        draftRevision,
        ...(publishedRevision === undefined ? {} : { publishedRevision }),
        pending,
        ...(read.publishNarrative ? { narrative: read.publishNarrative } : {}),
        ...(lastChangedBy ? { lastChangedBy } : {}),
        // Only an entry the reader may read names its page, so no owner leaks with it.
        ...withHref(address),
        refusals
      },
      config: read.config
    };
  }

  /**
   * An agent tries and reviews only the conversation's subject App or an App the conversation
   * created, as it tests only such a Workflow (`workflows.test`).
   */
  private async requireSubject(app: string, origin: OperationOrigin): Promise<void> {
    if (origin.kind !== "agent") return;
    const { stores, clientInstanceId } = this.options;
    const conversation = await stores.conversations.getConversation(
      clientInstanceId,
      origin.conversationId
    );
    const isSubject =
      conversation?.subject?.kind === APP_ASSET_KIND && conversation.subject.name === app;
    const reachable =
      conversation?.status === "active" &&
      (isSubject ||
        (await stores.conversations.createdAsset({
          clientInstanceId,
          conversationId: conversation.id,
          kind: APP_ASSET_KIND,
          name: app
        })));
    if (!reachable) {
      throw new AppError(
        "FORBIDDEN",
        "An agent may try only the conversation's subject App or an App the conversation created",
        { reason: "app_not_subject" },
        { exposeMessage: true }
      );
    }
  }
}

function resourceOf(asset: ConfigAssetRecord) {
  return accessResource(asset.kind, asset.name, asset.scope, asset.id);
}

const refusalDetailsSchema = z.object({
  reason: z.string().optional(),
  action: z.string().optional()
});

/** A refusal as the review names it: the reason the error carries and its sentence. */
function refusalOf(error: unknown): Refusal {
  if (!isAppError(error)) throw error;
  const details = refusalDetailsSchema.safeParse(error.details).data ?? {};
  const reason = details.reason ?? error.code.toLowerCase();
  const right = details.action;
  return { reason, message: error.message, ...(right === undefined ? {} : { right }) };
}
