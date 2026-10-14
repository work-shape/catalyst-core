// Follow-up ticket "operation face runs a definition in no registry" (S3-42 fix round, point
// 12): this file calls `runOperation` itself only because a draft and a Page run a definition
// no registry holds. Once the operation face has that method, this second caller goes.
import {
  APP_ASSET_KIND,
  workflowRunSchema,
  type AppActionCallResult,
  type AppActionPermission,
  type AppWorkflowRun
} from "@vivd-catalyst/api-contract";
import {
  appActionInputAsZod,
  compiledActionsOf,
  declaredDataStoresOf,
  type CompiledAppAction
} from "@vivd-catalyst/app-build";
import {
  APP_ACTION_CALLS_PER_MINUTE_PER_SESSION,
  APP_ACTION_INPUT_MAX_BYTES,
  AppError,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  getSubjectUserId,
  isAppError,
  isAppErrorCode,
  isFileSetId,
  operationDenialError,
  pageActionOperationName,
  type ActorAccess,
  type AppActionRefusal,
  type AppCallTarget,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type JsonObject,
  type OperationDefinition,
  type OperationOrigin,
  type ServedFileSet
} from "@vivd-catalyst/core";
import { runOperation, type OperationOutcome } from "@vivd-catalyst/tool-execution";
import { z } from "zod";
import { appContentView, checkAppContentToken } from "../app-content";
import { mayOpenAssetFileSet } from "../asset-access";
import { ConversationWorkflow } from "../conversations/conversation-workflow";
import type { ResolvedChatServerOptions } from "../types";
import {
  appActionDefinition,
  appActionPermission,
  appResourceOf,
  appRevisionHost,
  preloadedEnvironment,
  type AppActionEnvironment,
  type AppActionHost
} from "./action-source";
import { appActionBinding, type AppActionBinding } from "./action-kinds";

// A call a frame makes through the bridge. The frame holds no credential: it posts a message
// to the interface, and the interface makes the call here with the viewer's own session. So
// the caller of every call is the signed-in person, and every right is asked of that person.
// The call names the frame it comes from by the page session of its address. That address was
// minted for one person, one file set and one mount of the frame, and all three are checked
// here before anything is read from the manifest.

/**
 * Which revision a frame shows. A Page of a conversation and the draft of an App run in safe
 * mode: an action that changes something is refused there before anything else happens.
 */
type FrameMode = "page" | "draft" | "published";

/**
 * A revision as one viewer is shown it: what a call from its frame is decided on. The list of
 * an App's actions reads it for a viewer who has no frame open and names no page session.
 */
export interface ShownRevision {
  viewer: AuthenticatedIdentity;
  access: ActorAccess;
  pageSessionId: string;
  mode: FrameMode;
  host: AppActionHost;
  /** What the run's origin names as the revision: the App's revision, or the Page's file set. */
  revisionId: string;
  /** The App the frame shows, by its name. A Page of a conversation has none. */
  appName?: string;
  /**
   * The workspace the frame belongs to: the App's, or the one of the Page's conversation.
   * Every call of the frame carries it, so a setting that is narrowed to a workspace counts
   * for every named action of the frame.
   */
  workspaceId: CollaborationWorkspaceId | undefined;
  conversationId?: ServedFileSet["conversationId"];
  actions: CompiledAppAction[];
}

/** The frame a call comes from, once its address and its viewer were checked. */
export interface FrameSession extends ShownRevision {
  viewer: AuthenticatedUser;
}

export interface FrameSessionProof {
  pageSessionId: string;
  fileSetId: string;
  token: string;
}

interface FrameCall {
  correlationId: string;
  idempotencyKey: string | undefined;
  /** Sets the headers of the answer that name the run. */
  header(name: string, value: string): void;
}

function refusal(
  code: ConstructorParameters<typeof AppError>[0],
  reason: AppActionRefusal,
  message: string,
  details: Record<string, unknown> = {}
): AppError {
  return new AppError(code, message, { reason, ...details }, { exposeMessage: true });
}

const sessionInvalid = () =>
  refusal("NOT_FOUND", "session_invalid", "The page session is not valid. Reload the page.");

/** The name a read of a Workflow Run from a frame carries as its action. */
const WORKFLOW_RUN_READ_NAME = "workflow_runs.get";

const displayNameSchema = z.object({ displayName: z.string() });
const runReferenceSchema = z.object({ operationRunId: z.string() });

export class AppActionCalls {
  private readonly options: ResolvedChatServerOptions;
  private readonly conversations: ConversationWorkflow;
  private readonly environment: AppActionEnvironment;

  constructor(options: ResolvedChatServerOptions) {
    this.options = options;
    this.conversations = new ConversationWorkflow(options);
    // A named action asks its App itself, so the operation it stands for is read from the
    // registry as it is. A frame calls no Connection operation directly: it reaches a
    // Connection only through a named `connection` action of its manifest.
    this.environment = {
      registry: options.operationCalls.registry,
      modules: options.modules,
      policy: options.operationCalls.deps.policy
    };
  }

  /**
   * The frame a call names, for the signed-in caller. The token must be the one minted for
   * this caller, this file set and this page session, and the caller must still be served the
   * file set: a Page by reading its conversation, a revision of an App by the rule of
   * `apps.preview`. Every refusal says the same and tells nothing of what exists.
   */
  async session(
    caller: { user: AuthenticatedUser; access: ActorAccess },
    proof: FrameSessionProof
  ): Promise<FrameSession> {
    const { options } = this;
    const contentKey = options.pages?.contentKey;
    if (!contentKey || !isFileSetId(proof.fileSetId)) {
      throw sessionInvalid();
    }
    const checked = checkAppContentToken(contentKey, options.clientInstanceId, {
      token: proof.token,
      fileSetId: proof.fileSetId,
      nowSeconds: Math.floor(Date.now() / 1000)
    });
    if (
      !checked.ok ||
      checked.claims.pageSessionId !== proof.pageSessionId ||
      checked.claims.viewerId !== getSubjectUserId(caller.user)
    ) {
      throw sessionInvalid();
    }
    const fileSet = await options.stores.pages.getServedFileSet({
      clientInstanceId: options.clientInstanceId,
      fileSetId: proof.fileSetId
    });
    if (!fileSet) {
      throw sessionInvalid();
    }
    const shared = {
      viewer: caller.user,
      access: caller.access,
      pageSessionId: proof.pageSessionId,
      actions: compiledActionsOf(fileSet.manifest),
      dataStores: declaredDataStoresOf(fileSet.manifest)
    };
    if (!fileSet.asset) {
      const conversation = await this.conversations
        .requireConversationAccess(fileSet.conversationId, caller.user)
        .catch((error: unknown) => {
          throw isAppError(error) && error.code === "NOT_FOUND" ? sessionInvalid() : error;
        });
      const pageId = fileSet.owner.id;
      return {
        ...shared,
        mode: "page",
        host: {
          // Named by the Page, never by the id its manifest gives itself: that id is free
          // text of whoever wrote the Page and could be the name of a published App.
          operationName: (action) => pageActionOperationName(pageId, action),
          resource: undefined,
          dataStores: shared.dataStores,
          published: false,
          // The conversation was checked for this caller just now, and a Page runs reads
          // only, which never wait for anybody, so nothing asks again later.
          authorize: () => ({ allowed: true })
        },
        revisionId: fileSet.id,
        conversationId: fileSet.conversationId,
        workspaceId: conversation.collaborationWorkspaceId
      };
    }
    const { asset } = fileSet;
    const kind = options.configAssets.kinds.get(asset.kind);
    if (
      asset.kind !== APP_ASSET_KIND ||
      options.modules.offModuleOf("kind", asset.kind) !== undefined ||
      !mayOpenAssetFileSet(kind, caller.access, asset)
    ) {
      throw sessionInvalid();
    }
    const resource = appResourceOf(asset);
    // The view is the one the address was minted for, as far as its file set still holds it.
    const view = appContentView(checked.claims.mode, asset);
    return {
      ...shared,
      mode: view,
      appName: asset.name,
      workspaceId: resource.workspaceId,
      host: appRevisionHost(asset.name, resource, view, shared.dataStores),
      revisionId:
        view === "published" && asset.publishedRevisionId !== undefined
          ? asset.publishedRevisionId
          : (asset.revisionIds.at(-1) ?? asset.activeRevisionId)
    };
  }

  /**
   * What each action of the shown manifest would come to for the viewer. Each Connection and
   * each Data Store the actions name is read once, in two point reads, and the central settings
   * once: a manifest of 100 actions on one Connection costs three reads, not 200. No outside
   * system and no store's database is called.
   */
  async can(session: FrameSession): Promise<Record<string, AppActionPermission>> {
    return appActionPermissions(
      await preloadedEnvironment(this.environment, session.actions),
      session
    );
  }

  /** Calls one named action of the shown manifest: one call, one Operation Run. */
  async callAction(
    session: FrameSession,
    name: string,
    input: unknown,
    call: FrameCall
  ): Promise<AppActionCallResult> {
    await this.admit(session, input);
    const action = session.actions.find((candidate) => candidate.name === name);
    if (!action) {
      throw refusal("NOT_FOUND", "action_unknown", `The manifest names no action '${name}'.`);
    }
    const binding = appActionBinding(action);
    const { definition } = await appActionDefinition(this.environment, session.host, action);
    const origin = appOrigin(session, action.name, binding.target);
    if (action.effect === "changing" && session.mode !== "published" && binding.dryRun) {
      return this.dryRun(session, definition, binding.dryRun, input, {
        origin,
        correlationId: call.correlationId,
        parameters: appActionInputAsZod(action.input.schema)
      });
    }
    this.requireOutsideSafeMode(session, action.effect);
    return this.run(session, definition, input, origin, call);
  }

  /**
   * The answer of safe mode to a changing action whose kind can say what it would have done:
   * the caller's rights and the parameters are asked as a call would ask them, and then
   * nothing is called and no run is written. A call that would be refused is refused.
   */
  private async dryRun(
    session: FrameSession,
    definition: OperationDefinition,
    wouldHave: NonNullable<AppActionBinding["dryRun"]>,
    input: unknown,
    call: { origin: OperationOrigin; correlationId: string; parameters: z.ZodType<JsonObject> }
  ): Promise<AppActionCallResult> {
    // A named action decides its right itself (`appActionDefinition`).
    if (definition.action !== null)
      throw new AppError("INTERNAL", "A named action has no right of its own");
    const right = await definition.authorize(input, {
      actor: session.viewer,
      origin: call.origin,
      workspaceId: session.workspaceId,
      correlationId: call.correlationId,
      access: session.access,
      resource: session.host.resource
    });
    if (!right.allowed) {
      const { allowed: _allowed, ...denial } = right;
      throw operationDenialError({ kind: "forbidden", ...denial });
    }
    const parameters = call.parameters.safeParse(input);
    if (!parameters.success) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Operation input is invalid",
        { reason: "input_invalid", issues: parameters.error.issues },
        { exposeMessage: true }
      );
    }
    const dry = wouldHave(parameters.data);
    return {
      status: "dry_run",
      message: `${dry.wouldHave} ${
        session.mode === "page"
          ? "A Page of a conversation runs in safe mode and carries out nothing that changes something. Save the Page as an App and publish it."
          : "The draft of an App runs in safe mode and carries out nothing that changes something. Publish the App to carry it out."
      }`,
      result: dry.input
    };
  }

  /**
   * A Workflow Run that a `workflow` action of the shown manifest started, read with the
   * viewer's rights by `workflows.get_run`: whoever started a run reads it. A run of a
   * Workflow that no action of the manifest starts, or one another person started, is
   * answered as one that does not exist, also to a viewer who may read every run: a frame
   * follows what its viewer started and reads nothing else.
   */
  async workflowRun(
    session: FrameSession,
    runId: string,
    correlationId: string
  ): Promise<AppWorkflowRun> {
    await this.admit(session, null);
    const started = new Set(
      session.actions.flatMap((action) => (action.kind === "workflow" ? [action.workflow] : []))
    );
    const none = () => new AppError("NOT_FOUND", "There is no such Workflow Run");
    if (started.size === 0) throw none();
    const { result } = await runOperation(
      {
        operation: "workflows.get_run",
        effect: "reading",
        input: { runId },
        actor: session.viewer,
        origin: appOrigin(session, WORKFLOW_RUN_READ_NAME),
        workspaceId: session.workspaceId,
        correlationId
      },
      this.options.operationCalls.deps
    );
    if (result.status === "failed" && isAppErrorCode(result.error.code)) {
      throw new AppError(result.error.code, result.error.message, undefined, {
        exposeMessage: true
      });
    }
    const run = result.status === "done" ? workflowRunSchema.safeParse(result.output) : undefined;
    if (!run?.success) throw none();
    const { workflow, startedBy } = run.data;
    if (!started.has(workflow) || startedBy.kind !== "user" || startedBy.id !== session.viewer.id) {
      throw none();
    }
    return appWorkflowRunOf(run.data);
  }

  /** The limit of one page session and the size of one input, before anything is read. */
  private async admit(session: FrameSession, input: unknown): Promise<void> {
    const { config, rateLimiter } = this.options;
    if (config.rateLimits.enabled) {
      const decision = await rateLimiter.consume(`app-session:${session.pageSessionId}`, {
        limit: APP_ACTION_CALLS_PER_MINUTE_PER_SESSION,
        windowMs: 60_000
      });
      if (!decision.allowed) {
        throw new AppError(
          "RATE_LIMITED",
          `This page made more than ${APP_ACTION_CALLS_PER_MINUTE_PER_SESSION} calls in a minute (APP_ACTION_CALLS_PER_MINUTE_PER_SESSION). Try again later.`,
          {
            reason: "rate_limited",
            retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
          }
        );
      }
    }
    const bytes = Buffer.byteLength(JSON.stringify(input ?? null));
    if (bytes > APP_ACTION_INPUT_MAX_BYTES) {
      throw refusal(
        "VALIDATION_FAILED",
        "input_invalid",
        `The input has ${bytes} bytes. It has at most ${APP_ACTION_INPUT_MAX_BYTES} (APP_ACTION_INPUT_MAX_BYTES).`
      );
    }
  }

  private requireOutsideSafeMode(session: FrameSession, effect: OperationDefinition["effect"]) {
    if (effect === "changing" && session.mode !== "published") {
      throw refusal(
        "CONFLICT",
        "draft_safe_mode",
        session.mode === "page"
          ? "A Page of a conversation runs in safe mode: an action that changes something is not carried out. Save the Page as an App and publish it."
          : "The draft of an App runs in safe mode: an action that changes something is not carried out. Publish the App to use it."
      );
    }
  }

  /**
   * Runs the call through the call path. The definition is the one built from the manifest
   * the frame shows, so a draft and a Page run what a published revision would. A call that
   * waited for an approval is executed later from the registry: a named action from the
   * published App while its revision is still the one the call was made in.
   */
  private async run(
    session: FrameSession,
    definition: OperationDefinition,
    input: unknown,
    origin: OperationOrigin,
    call: FrameCall
  ): Promise<AppActionCallResult> {
    const { deps } = this.options.operationCalls;
    let outcome: OperationOutcome;
    try {
      outcome = await runOperation(
        {
          operation: definition.name,
          effect: definition.effect,
          input,
          actor: session.viewer,
          origin,
          workspaceId: session.workspaceId,
          idempotencyKey: call.idempotencyKey,
          correlationId: call.correlationId
        },
        {
          ...deps,
          registry: {
            ...deps.registry,
            resolve: (name) =>
              name === definition.name ? Promise.resolve(definition) : deps.registry.resolve(name)
          }
        }
      );
    } catch (error) {
      // A repeated call that cannot be answered still names the run that holds its key.
      const held = isAppError(error) ? runReferenceSchema.safeParse(error.details) : undefined;
      if (held?.success) call.header("operation-run-id", held.data.operationRunId);
      // The call path refuses an input that does not fit before a run exists. The frame reads
      // the reason, as it reads the one of the Connection's own check.
      const details = isAppError(error) ? detailsOf(error.details) : {};
      if (isAppError(error) && error.code === "VALIDATION_FAILED" && "issues" in details) {
        throw new AppError(
          error.code,
          error.message,
          { ...details, reason: "input_invalid" },
          { exposeMessage: true }
        );
      }
      throw error;
    }
    const { result, run } = outcome;
    // A refusal and a failure name their run too, so the frame's error can be traced.
    const reference = outcome.unrecorded ? {} : { operationRunId: run.id };
    if (!outcome.unrecorded) call.header("operation-run-id", run.id);
    if (outcome.replayed) call.header("idempotent-replayed", "true");
    switch (result.status) {
      case "done":
        return { runId: run.id, status: "done", result: result.output };
      case "pending_approval":
        return { runId: run.id, status: "pending_approval" };
      case "denied": {
        const denied = operationDenialError(result.reason);
        throw new AppError(denied.code, denied.message, {
          ...detailsOf(denied.details),
          ...(await this.refusedConnection(session, result.reason, origin)),
          ...reference
        });
      }
      case "failed":
        throw isAppErrorCode(result.error.code)
          ? new AppError(
              result.error.code,
              result.error.message,
              { ...detailsOf(result.error.details), ...reference },
              { exposeMessage: true }
            )
          : new AppError("INTERNAL", "The operation failed", reference);
      case "expired":
        throw new AppError(
          "OPERATION_EXPIRED",
          "The call expired before it was approved. Call again with a new Idempotency-Key.",
          { operationRunId: run.id }
        );
      case "pending_confirmation":
        throw new AppError("INTERNAL", "A call of a frame cannot wait for a confirmation");
      // A frame's call carries no draft context until APP-4: a draft refuses a changing action.
      case "dry_run":
        throw new AppError("INTERNAL", "A call of a frame is not simulated before APP-4");
    }
  }

  /**
   * What a refusal for the missing right `connection.use` adds for the person: that it is
   * that refusal, and the Connection's label where the viewer may read the Connection. The
   * interface makes the sentence from it in the person's language, so no App words it. A
   * viewer who may not read the Connection is told no label, by the rule of the Connection's
   * own refusal: a refusal must not show a Connection to somebody who may not see it. One
   * point read, on this refusal only.
   */
  private async refusedConnection(
    session: FrameSession,
    denial: Extract<OperationOutcome["result"], { status: "denied" }>["reason"],
    origin: OperationOrigin
  ): Promise<{ connectionUseDenied?: true; frame?: "page" | "app"; connectionLabel?: string }> {
    if (
      denial.kind !== "forbidden" ||
      denial.action !== CONNECTION_ACTIONS.use ||
      origin.kind !== "app" ||
      !origin.target ||
      !("connection" in origin.target)
    ) {
      return {};
    }
    const asset = await this.options.stores.configAssets.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: CONNECTION_ASSET_KIND,
      name: origin.target.connection
    });
    const label = displayNameSchema.safeParse(asset?.config);
    const readable =
      asset !== undefined &&
      session.access.authorize(CONNECTION_ACTIONS.read, {
        kind: CONNECTION_ASSET_KIND,
        assetId: asset.id,
        name: asset.name
      }).allowed;
    return {
      connectionUseDenied: true,
      // The sentence names what the person looks at: a Page of a conversation, or an App.
      frame: session.mode === "page" ? "page" : "app",
      ...(readable && label.success ? { connectionLabel: label.data.displayName } : {})
    };
  }
}

/** The origin of a call from the frame of a shown revision, as its run names it. */
function appOrigin(
  shown: ShownRevision,
  actionName: string,
  target?: AppCallTarget
): Extract<OperationOrigin, { kind: "app" }> {
  return {
    kind: "app",
    ...(shown.appName === undefined ? {} : { appName: shown.appName }),
    appRevisionId: shown.revisionId,
    actionName,
    pageSessionId: shown.pageSessionId,
    ...(shown.conversationId === undefined ? {} : { conversationId: shown.conversationId }),
    ...(target === undefined ? {} : { target })
  };
}

/**
 * A Workflow Run as a frame follows it. A read of a run answers the start of its result as
 * JSON text; a frame is given the result itself where that text is all of it.
 */
function appWorkflowRunOf(run: z.infer<typeof workflowRunSchema>): AppWorkflowRun {
  const preview = run.outputPreview;
  let output: { output?: unknown; outputTruncated?: true } = {};
  if (preview?.truncated) {
    output = { outputTruncated: true };
  } else if (preview) {
    try {
      output = { output: JSON.parse(preview.text) };
    } catch {
      output = { outputTruncated: true };
    }
  }
  return {
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    ...output,
    ...(run.error ? { error: { code: run.error.code, message: run.error.message } } : {}),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt })
  };
}

/**
 * What each action of a shown revision would come to for its viewer, by the rule a call from
 * its frame is decided by: a changing action outside a published revision is refused, and
 * every other one is asked of the App, of the Connection and of the policy. `environment` is
 * one that holds the operations the actions stand for (`preloadedEnvironment`).
 */
export async function appActionPermissions(
  environment: AppActionEnvironment,
  shown: ShownRevision
): Promise<Record<string, AppActionPermission>> {
  const can: Record<string, AppActionPermission> = {};
  for (const action of shown.actions) {
    const binding = appActionBinding(action);
    // Safe mode refuses a changing action, but for one whose kind answers what it would have done.
    const permission =
      action.effect === "changing" && shown.mode !== "published" && !binding.dryRun
        ? "deny"
        : await appActionPermission(
            environment,
            await appActionDefinition(environment, shown.host, action),
            {
              actor: shown.viewer,
              origin: appOrigin(shown, action.name, binding.target),
              workspaceId: shown.workspaceId,
              correlationId: "",
              access: shown.access,
              resource: shown.host.resource
            }
          );
    Object.defineProperty(can, action.name, { value: permission, enumerable: true });
  }
  return can;
}

function detailsOf(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details))
    : {};
}
