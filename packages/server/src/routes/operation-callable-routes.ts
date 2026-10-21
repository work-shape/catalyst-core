import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { Route } from "../http/route";
import { listCallableOperations } from "../platform/platform-callable-operations";
import type { ChatServerOptions } from "../types";

/**
 * The operations a step of a Workflow may call, for the Settings of a step (WF-EDIT-3). The
 * agent's `platform.assets.operations` is the projection of the same listing.
 */
export function registerOperationCallableRoutes(route: Route, options: ChatServerOptions): void {
  route.operation(apiOperations["operations.list_callable"], {
    // No right of its own: the listing asks each operation's own check, dry, and lists only
    // those that pass. A caller who may call none receives an empty page.
    authorize: () => ({ allowed: true }),
    execute: ({ for: _audience, ...input }, context) =>
      listCallableOperations(options, context, { for: "workflow" }, input)
  });
}
