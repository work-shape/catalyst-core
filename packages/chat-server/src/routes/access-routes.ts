import { apiOperations } from "@vivd-catalyst/api-contract";
import type { Namespace, PermissionGrant } from "@vivd-catalyst/core";
import { AccessWorkflow } from "../access-workflow";
import type { Route } from "../http/route";
import { requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

/** Governance records, registered like user administration. */
export function registerAccessRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new AccessWorkflow(options);

  route(apiOperations["permissions.grant"], async ({ user, context, body }) =>
    grantView(await workflow.grant(user, context, body))
  );

  route(apiOperations["permissions.revoke"], async ({ user, context, params }) =>
    grantView(
      await workflow.revoke(user, context, requirePathParam(params.grantId, "Missing grant id"))
    )
  );

  route(apiOperations["permissions.list"], async ({ query, paging }) =>
    (
      await workflow.listGrants({
        holderKind: query.holderKind,
        holderId: query.holderId,
        action: query.action,
        scopeKind: query.scopeKind,
        page: paging
      })
    ).map(grantView)
  );

  route(apiOperations["permissions.effective"], ({ user, access, query }) =>
    workflow.effective(user, access, query)
  );

  route(apiOperations["namespaces.create"], async ({ user, context, body }) =>
    namespaceView(await workflow.createNamespace(user, context, body))
  );

  route(apiOperations["namespaces.update"], async ({ user, context, params, body }) =>
    namespaceView(
      await workflow.updateNamespace(user, context, { ...body, prefix: prefixParam(params) })
    )
  );

  route(apiOperations["namespaces.list"], async () =>
    (await workflow.listNamespaces()).map((namespace) => ({
      ...namespaceView(namespace),
      grantCount: namespace.grantCount,
      assetCount: namespace.assetCount
    }))
  );

  route(apiOperations["namespaces.delete"], async ({ user, context, params }) =>
    namespaceView(await workflow.deleteNamespace(user, context, prefixParam(params)))
  );
}

function prefixParam(params: { prefix: string }): string {
  return requirePathParam(params.prefix, "Missing Namespace prefix");
}

function grantView(grant: PermissionGrant) {
  const { clientInstanceId: _clientInstanceId, ...view } = grant;
  return view;
}

/** On the wire a list that does not restrict is `null`, so it cannot be mistaken for empty. */
function namespaceView(namespace: Namespace) {
  return {
    prefix: namespace.prefix,
    displayName: namespace.displayName,
    allowedToolNames: namespace.allowedToolNames ?? null,
    allowedModelBindingIds: namespace.allowedModelBindingIds ?? null,
    createdBy: namespace.createdBy,
    createdAt: namespace.createdAt
  };
}
