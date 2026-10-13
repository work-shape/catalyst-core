import { APP_ASSET_KIND, apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, asCollaborationWorkspaceId } from "@vivd-catalyst/core";
import { AppActionCalls } from "../apps/action-call";
import { AppActionList } from "../apps/action-list";
import { AppWorkflow } from "../apps/app-workflow";
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

  route.operation(apiOperations["apps.create_from_page"], {
    authorize: (input, { access }) => workflow.authorizeCreate(access, input),
    resource: (input) => ({
      kind: APP_ASSET_KIND,
      id: input.name,
      name: input.name,
      workspaceId: asCollaborationWorkspaceId(input.workspaceId)
    }),
    changeClass: "reversible",
    module: APPS_MODULE,
    execute: (input, context) => workflow.createFromPage(context, input)
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
    authorize: (input, { access }) => workflow.authorizeUpdate(access, input),
    resource: (input) => ({
      kind: APP_ASSET_KIND,
      id: input.app,
      name: input.app,
      workspaceId: asCollaborationWorkspaceId(input.workspaceId)
    }),
    changeClass: "reversible",
    module: APPS_MODULE,
    execute: (input, context) => workflow.updateFromPage(context, input)
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

  // The three calls of a frame. The interface makes them with the viewer's session after the
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
    apiOperations["apps.sessions.call_connection"],
    async ({ user, access, context, params, body, request, reply }) => {
      void reply.header("cache-control", "no-store");
      const session = await actions.session(
        { user, access },
        { pageSessionId: params.pageSessionId, fileSetId: body.fileSetId, token: body.token }
      );
      return actions.callConnection(
        session,
        { connection: params.connection, operation: params.operation },
        body.input,
        {
          correlationId: context.correlationId,
          idempotencyKey: idempotencyKeyOf(request.headers["idempotency-key"]),
          header: (name, value) => void reply.header(name, value)
        }
      );
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
