import { APP_ASSET_KIND, apiOperations } from "@vivd-catalyst/api-contract";
import { asCollaborationWorkspaceId } from "@vivd-catalyst/core";
import { AppWorkflow } from "../apps/app-workflow";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The module that brings Pages and Apps. */
const APPS_MODULE = "apps";

/**
 * What an App has beside the operations of every asset. Writing, publishing, discarding and
 * deleting an App are `assets.put`, `assets.publish`, `assets.discard_draft` and
 * `assets.delete` with the kind `app`.
 */
export function registerAppRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new AppWorkflow(options);

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

  // Where a caller's right to an App is checked with the caller present. The address this
  // answers is all a file request carries: it is a secret until it expires, and it serves
  // while its viewer may still be served that revision.
  route(apiOperations["apps.preview"], async ({ user, access, params, body, reply }) => {
    void reply.header("cache-control", "no-store");
    return workflow.preview({ user, access }, { app: params.app, mode: body.mode });
  });
}
