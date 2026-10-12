// Follow-up ticket "operation face runs a definition in no registry" (S3-42 fix round, point
// 12): this file calls `runOperation` itself only because a draft and a Page run a definition
// no registry holds. Once the operation face has that method, this second caller goes.
import {
  APP_ASSET_KIND,
  type AppActionCallResult,
  type AppActionPermission
} from "@vivd-catalyst/api-contract";
import {
  compiledActionsOf,
  declaredConnectionsOf,
  type CompiledAppAction
} from "@vivd-catalyst/app-build";
import {
  APP_ACTION_CALLS_PER_MINUTE_PER_SESSION,
  APP_ACTION_INPUT_MAX_BYTES,
  APP_CONNECTION_CALL_ACTION_NAME,
  AppError,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  appActionOperationName,
  connectionCallError,
  connectionOperationName,
  getSubjectUserId,
  isAppError,
  isAppErrorCode,
  isFileSetId,
  operationDenialError,
  pageActionOperationName,
  type ActorAccess,
  type AppActionRefusal,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type OperationDefinition,
  type OperationOrigin,
  type ServedFileSet
} from "@vivd-catalyst/core";
import { runOperation, type OperationOutcome } from "@vivd-catalyst/tool-execution";
import { z } from "zod";
import { checkAppContentToken } from "../app-content";
import { decide, mayOpenAssetFileSet } from "../asset-access";
import { ConversationWorkflow } from "../conversations/conversation-workflow";
import type { ResolvedChatServerOptions } from "../types";
import {
  appActionDefinition,
  appActionPermission,
  appResourceOf,
  authorizePublishedApp,
  preloadedEnvironment,
  type AppActionEnvironment,
  type AppActionHost
} from "./action-source";
import { APP_ACTIONS } from "./app-kind";

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

/** The frame a call comes from, once its address and its viewer were checked. */
export interface FrameSession {
  viewer: AuthenticatedUser;
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
   * for a named action and for a direct call of a Connection alike.
   */
  workspaceId: CollaborationWorkspaceId | undefined;
  conversationId?: ServedFileSet["conversationId"];
  actions: CompiledAppAction[];
  connections: string[];
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
    // registry as it is. The call path's own registry asks the App of a call's origin before
    // a Connection operation (`guardAppOrigin`), which a direct call below goes through.
    this.environment = {
      registry: options.operationCalls.registry,
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
      connections: declaredConnectionsOf(fileSet.manifest)
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
    // The view is the one the address was minted for. The file set does not say it: right after
    // a publish or a discarded draft the draft and the published revision are one file set.
    // An address that asked for the published view counts as that only while its file set is
    // still what is published, and an address that names no view is taken as a draft.
    const published =
      checked.claims.mode === "published" &&
      asset.publishedRevisionId !== undefined &&
      asset.revisionIds.includes(asset.publishedRevisionId);
    return {
      ...shared,
      mode: published ? "published" : "draft",
      appName: asset.name,
      workspaceId: resource.workspaceId,
      host: {
        operationName: (action) => appActionOperationName(asset.name, action),
        resource,
        authorize: (context) =>
          published
            ? authorizePublishedApp(context, resource)
            : decide(context.access, APP_ACTIONS.write, resource)
      },
      revisionId:
        published && asset.publishedRevisionId !== undefined
          ? asset.publishedRevisionId
          : (asset.revisionIds.at(-1) ?? asset.activeRevisionId)
    };
  }

  /**
   * What each action of the shown manifest would come to for the viewer. Each Connection the
   * actions name is read once, in two point reads, and the central settings once: a manifest
   * of 100 actions on one Connection costs three reads, not 200. No outside system is called.
   */
  async can(session: FrameSession): Promise<Record<string, AppActionPermission>> {
    const environment = await preloadedEnvironment(this.environment, session.actions);
    const can: Record<string, AppActionPermission> = {};
    for (const action of session.actions) {
      const permission =
        action.effect === "changing" && session.mode !== "published"
          ? "deny"
          : await appActionPermission(
              environment,
              await appActionDefinition(environment, session.host, action),
              {
                actor: session.viewer,
                origin: this.origin(session, action.name, action),
                workspaceId: session.workspaceId,
                correlationId: "",
                access: session.access,
                resource: session.host.resource
              }
            );
      Object.defineProperty(can, action.name, { value: permission, enumerable: true });
    }
    return can;
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
    this.requireOutsideSafeMode(session, action.effect);
    const { definition } = await appActionDefinition(this.environment, session.host, action);
    return this.run(session, definition, input, this.origin(session, action.name, action), call);
  }

  /**
   * Calls one operation of a Connection the shown manifest lists. The run is the Connection
   * operation's own, with the origin `app`, so the exposure `bridge`, the right on the
   * Connection and the operation's policy are asked where every call of it asks them. The
   * right on the App is asked before them, by the frame's own rule here and by the App the
   * origin names where the registry resolves the operation (`guardAppOrigin`). The second is
   * what still asks when a call that waited is executed.
   */
  async callConnection(
    session: FrameSession,
    target: { connection: string; operation: string },
    input: unknown,
    call: FrameCall
  ): Promise<AppActionCallResult> {
    await this.admit(session, input);
    if (!session.connections.includes(target.connection)) {
      throw refusal(
        "FORBIDDEN",
        "connection_not_declared",
        `The manifest does not list the Connection '${target.connection}' under 'connections'.`
      );
    }
    const operation = await this.options.operationCalls.deps.registry.resolve(
      connectionOperationName(target.connection, target.operation)
    );
    if (!operation || operation.action !== null) {
      throw connectionCallError("operation_unknown");
    }
    this.requireOutsideSafeMode(session, operation.effect);
    const { host } = session;
    const definition: OperationDefinition = {
      ...operation,
      async authorize(operationInput, context) {
        const own = await host.authorize(context);
        return own.allowed ? operation.authorize(operationInput, context) : own;
      }
    };
    return this.run(
      session,
      definition,
      input,
      this.origin(session, APP_CONNECTION_CALL_ACTION_NAME, target),
      call
    );
  }

  private origin(
    session: FrameSession,
    actionName: string,
    target: { connection: string; operation: string }
  ): Extract<OperationOrigin, { kind: "app" }> {
    return {
      kind: "app",
      ...(session.appName === undefined ? {} : { appName: session.appName }),
      appRevisionId: session.revisionId,
      actionName,
      pageSessionId: session.pageSessionId,
      ...(session.conversationId === undefined ? {} : { conversationId: session.conversationId }),
      target: { connection: target.connection, operation: target.operation }
    };
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
   * published App while its revision is still the one the call was made in, and a Connection
   * operation after its App was asked again.
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
  ): Promise<{ connectionUseDenied?: true; connectionLabel?: string }> {
    if (
      denial.kind !== "forbidden" ||
      denial.action !== CONNECTION_ACTIONS.use ||
      origin.kind !== "app" ||
      !origin.target
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
      ...(readable && label.success ? { connectionLabel: label.data.displayName } : {})
    };
  }
}

function detailsOf(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details))
    : {};
}
