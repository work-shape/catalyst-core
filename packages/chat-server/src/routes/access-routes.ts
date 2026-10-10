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
    grantView(await workflow.grant(user, context, body), await workflow.hiddenUserIds(user))
  );

  route(apiOperations["permissions.revoke"], async ({ user, context, params }) =>
    grantView(
      await workflow.revoke(user, context, requirePathParam(params.grantId, "Missing grant id")),
      await workflow.hiddenUserIds(user)
    )
  );

  route(apiOperations["permissions.list"], async ({ user, query, paging }) => {
    const hidden = await workflow.hiddenUserIds(user);
    const grants = await workflow.listGrants(user, {
      holderKind: query.holderKind,
      holderId: query.holderId,
      action: query.action,
      scopeKind: query.scopeKind,
      page: paging
    });
    return grants.map((grant) => grantView(grant, hidden));
  });

  route(apiOperations["permissions.effective"], ({ user, access, query }) =>
    workflow.effective(user, access, query)
  );

  route(apiOperations["namespaces.create"], async ({ user, context, body }) =>
    namespaceView(
      await workflow.createNamespace(user, context, body),
      await workflow.hiddenUserIds(user)
    )
  );

  route(apiOperations["namespaces.update"], async ({ user, context, params, body }) =>
    namespaceView(
      await workflow.updateNamespace(user, context, { ...body, prefix: prefixParam(params) }),
      await workflow.hiddenUserIds(user)
    )
  );

  route(apiOperations["namespaces.list"], async ({ user }) => {
    const hidden = await workflow.hiddenUserIds(user);
    return (await workflow.listNamespaces()).map((namespace) => ({
      ...namespaceView(namespace, hidden),
      grantCount: namespace.grantCount,
      assetCount: namespace.assetCount
    }));
  });

  route(apiOperations["namespaces.delete"], async ({ user, context, params }) =>
    namespaceView(
      await workflow.deleteNamespace(user, context, prefixParam(params)),
      await workflow.hiddenUserIds(user)
    )
  );
}

function prefixParam(params: { prefix: string }): string {
  return requirePathParam(params.prefix, "Missing Namespace prefix");
}

/** `grantedBy` is left out when the caller is not shown the user who wrote the row. */
function grantView(grant: PermissionGrant, hidden: ReadonlySet<string>) {
  const { clientInstanceId: _clientInstanceId, grantedBy, ...view } = grant;
  return hidden.has(grantedBy) ? view : { ...view, grantedBy };
}

/**
 * On the wire a list that does not restrict is `null`, so it cannot be mistaken for empty.
 * `createdBy` is left out when the caller is not shown the user who registered the Namespace.
 */
function namespaceView(namespace: Namespace, hidden: ReadonlySet<string>) {
  return {
    prefix: namespace.prefix,
    displayName: namespace.displayName,
    allowedToolNames: namespace.allowedToolNames ?? null,
    allowedModelBindingIds: namespace.allowedModelBindingIds ?? null,
    ...(hidden.has(namespace.createdBy) ? {} : { createdBy: namespace.createdBy }),
    createdAt: namespace.createdAt
  };
}
