import { APP_ASSET_KIND, apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  PAGE_FILE_SET_HELD_KEY,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AppUserStorageMutation,
  asUserId,
  asCollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import { AppActionCalls } from "../apps/action-call";
import { AppActionList } from "../apps/action-list";
import { AppWorkflow } from "../apps/app-service";
import { AppDraftTries } from "../apps/app-tries";
import { DraftHosts } from "../apps/draft-hosts";
import type { Route } from "../http/route";
import type { ResolvedChatServerOptions } from "../types";

/** The module that brings Pages and Apps. */
const APPS_MODULE = "apps";

/**
 * What an App has beside the operations of every asset: it is saved from a Page and updated
 * from it. Writing its files, publishing, discarding and deleting an App are `assets.put`, `assets.publish`, `assets.discard_draft` and
 * `assets.delete` with the kind `app`.
 */
export function registerAppRoutes(route: Route, options: ResolvedChatServerOptions): void {
  const workflow = new AppWorkflow(options);
  const actions = new AppActionCalls(options);
  const actionList = new AppActionList(options);
  const draftHosts = new DraftHosts(options);
  const tries = new AppDraftTries(options, { apps: workflow, actions });

  route.operation(apiOperations["apps.create_from_page"], {
    authorize: (input, { actor, access }) => workflow.authorizeCreate(actor, access, input),
    resource: (input) => ({
      kind: APP_ASSET_KIND,
      id: input.name,
      name: input.name,
      workspaceId: asCollaborationWorkspaceId(input.workspaceId)
    }),
    changeClass: "reversible",
    module: APPS_MODULE,
    beforeEvents: (input) => [workflow.writeEventFromPage({ ...input, app: input.name })],
    heldInputKeys: [PAGE_FILE_SET_HELD_KEY],
    execute: (input, context) => workflow.createFromPage(context, input, context.beforeEvents)
  });

  route.operation(apiOperations["apps.actions.list"], {
    authorize: (input, { access }) => actionList.authorize(access, input),
    resource: (input) =>
      input.app === undefined
        ? undefined
        : { kind: APP_ASSET_KIND, id: input.app, name: input.app },
    module: APPS_MODULE,
    execute: (input, context) => actionList.list(context, input)
  });

  route.operation(apiOperations["apps.update_from_page"], {
    authorize: (input, { actor, access }) => workflow.authorizeUpdate(actor, access, input),
    resource: (input) => ({
      kind: APP_ASSET_KIND,
      id: input.app,
      name: input.app,
      workspaceId: asCollaborationWorkspaceId(input.workspaceId)
    }),
    changeClass: "reversible",
    module: APPS_MODULE,
    beforeEvents: (input) => [workflow.writeEventFromPage(input)],
    heldInputKeys: [PAGE_FILE_SET_HELD_KEY],
    execute: (input, context) => workflow.updateFromPage(context, input, context.beforeEvents)
  });

  // An agent tries an action of an App's draft as the person's click would, without a frame
  // (DP-2). The call of the action is its own run, decided as the click's; a test needs no
  // confirmation unless an administrator made its policy stricter, like `workflows.test`.
  route.operation(apiOperations["apps.try_action"], {
    defaultPolicy: "allow",
    authorize: (input, caller) => tries.authorize(caller, input.app),
    resource: (input) => ({ kind: APP_ASSET_KIND, id: input.app, name: input.app }),
    module: APPS_MODULE,
    execute: (input, context) => tries.tryAction(context, input)
  });

  route.operation(apiOperations["apps.publish_review"], {
    authorize: (input, caller) => tries.authorize(caller, input.app),
    resource: (input) => ({ kind: APP_ASSET_KIND, id: input.app, name: input.app }),
    module: APPS_MODULE,
    execute: (input, context) => tries.publishReview(context, input.app)
  });

  // A person allows an outside host for their own view of a draft (DRAFT-HOSTS-1). Every check
  // runs before the call is decided and again when it runs: a policy that waited does not
  // carry a check over a change of the draft or of the person's rights.
  route.operation(apiOperations["apps.allow_draft_host"], {
    authorize: async (input, { actor, access }) => {
      await draftHosts.target(actor, access, input);
      return { allowed: true };
    },
    // A setting narrowed to a workspace or to Apps finds the call of an App's draft.
    policyTargets: (input) => draftHosts.policyTargets(input.fileSetId),
    changeClass: "reversible",
    module: APPS_MODULE,
    execute: (input, context) => draftHosts.allow(context, input)
  });

  // Asked by the surface of a Page each time it opens. What it tells of an App is decided by
  // the caller's right to write that App.
  route(apiOperations["apps.get_from_page"], ({ user, access, params, query }) =>
    workflow.fromPage({ user, access }, { ...params, ...(query.app ? { app: query.app } : {}) })
  );

  // Where a caller's right to an App is checked with the caller present. The address this
  // answers is all a file request carries: it is a secret until it expires, and it serves
  // while its viewer may still be served that revision.
  route(apiOperations["apps.preview"], async ({ user, access, params, body, reply }) => {
    void reply.header("cache-control", "no-store");
    return workflow.preview({ user, access }, { app: params.app, mode: body.mode });
  });

  // The calls of a frame. The interface makes them with the viewer's session after the
  // frame asked through the bridge, and names the frame by its page session. The right on the
  // Page or the App is decided here and in the call path, with the caller present.
  route(apiOperations["apps.sessions.context"], async ({ user, access, params, body, reply }) => {
    void reply.header("cache-control", "no-store");
    const session = await actions.session(
      { user, access },
      { pageSessionId: params.pageSessionId, fileSetId: body.fileSetId, token: body.token }
    );
    return { can: await actions.can(session) };
  });

  route.operation(apiOperations["apps.sessions.write_storage"], {
    module: APPS_MODULE,
    changeClass: "reversible",
    defaultPolicy: "allow",
    // The token and personal value never enter a held input, fingerprint or audit row.
    inputWithoutSecrets: (input) => {
      const mutation: AppUserStorageMutation =
        input.mutation.type === "set"
          ? { type: "set", key: "[redacted]", value: "[redacted]" }
          : input.mutation.type === "remove"
            ? { type: "remove", key: "[redacted]" }
            : input.mutation.type === "batch"
              ? { type: "batch", clear: false, values: {} }
              : { type: "clear" };
      return { ...input, token: "[redacted]", mutation };
    },
    authorize: async (input, { actor, access }) => {
      if (isAuthenticatedServicePrincipal(actor))
        return { allowed: false, action: "apps.sessions.write_storage", reason: "no_grant" };
      const session = await actions.session({ user: actor, access }, input);
      if (!session.appId) throw new AppError("NOT_FOUND", "App storage is not available");
      return { allowed: true };
    },
    execute: async (input, { actor, access }) => {
      if (isAuthenticatedServicePrincipal(actor))
        throw new AppError("NOT_FOUND", "App storage is not available");
      // Recheck the same parsed proof at dispatch, after policy and admission awaited.
      const session = await actions.session({ user: actor, access }, input);
      if (!session.appId) throw new AppError("NOT_FOUND", "App storage is not available");
      await options.stores.pages.mutateAppUserStorage({
        clientInstanceId: options.clientInstanceId,
        appId: session.appId,
        userId: asUserId(getSubjectUserId(actor)),
        mutation: input.mutation
      });
      return { saved: true };
    }
  });

  route(
    apiOperations["apps.sessions.call_action"],
    async ({ user, access, context, params, body, request, reply }) => {
      void reply.header("cache-control", "no-store");
      const session = await actions.session(
        { user, access },
        { pageSessionId: params.pageSessionId, fileSetId: body.fileSetId, token: body.token }
      );
      return actions.callAction(session, params.name, body.input, {
        correlationId: context.correlationId,
        idempotencyKey: idempotencyKeyOf(request.headers["idempotency-key"]),
        header: (name, value) => void reply.header(name, value)
      });
    }
  );

  route(
    apiOperations["apps.sessions.get_workflow_run"],
    async ({ user, access, context, params, body, reply }) => {
      void reply.header("cache-control", "no-store");
      const session = await actions.session(
        { user, access },
        { pageSessionId: params.pageSessionId, fileSetId: body.fileSetId, token: body.token }
      );
      return actions.workflowRun(session, params.runId, context.correlationId);
    }
  );
}

/** The key of a changing call, as the caller sent it. One header, one value. */
function idempotencyKeyOf(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    throw new AppError("VALIDATION_FAILED", "A call takes one Idempotency-Key");
  }
  return header;
}
