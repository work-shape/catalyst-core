import { apiOperations } from "@vivd-catalyst/api-contract";
import type {
  ActorAccess,
  AssetKindRegistry,
  Namespace,
  PermissionGrant
} from "@vivd-catalyst/core";
import { AccessWorkflow, type GrantViewContext } from "../access-workflow";
import type { Route } from "../http/route";
import { requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

/** Governance records, registered like user administration. */
export function registerAccessRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new AccessWorkflow(options);
  const { kinds } = options.configAssets;

  route(apiOperations["permissions.grant"], async ({ user, access, context, body }) => {
    const grant = await workflow.grant(user, context, body);
    return grantView(grant, await workflow.grantViewContext(user, [grant]), access, kinds);
  });

  route(apiOperations["permissions.revoke"], async ({ user, access, context, params }) => {
    const grant = await workflow.revoke(
      user,
      context,
      requirePathParam(params.grantId, "Missing grant id")
    );
    return grantView(grant, await workflow.grantViewContext(user, [grant]), access, kinds);
  });

  route(apiOperations["permissions.list"], async ({ user, access, query, paging }) => {
    const grants = await workflow.listGrants(user, {
      holderKind: query.holderKind,
      holderId: query.holderId,
      action: query.action,
      scopeKind: query.scopeKind,
      page: paging
    });
    const view = await workflow.grantViewContext(user, grants);
    return grants.map((grant) => grantView(grant, view, access, kinds));
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

/**
 * `grantedBy` is left out when the caller is not shown the user who wrote the row. An asset
 * scope carries the asset it names, also after that asset was deleted. The asset's name is
 * left out for a caller who may not read every asset of that kind: managing users does not
 * open the names of agents and skills.
 */
function grantView(
  grant: PermissionGrant,
  context: GrantViewContext,
  access: ActorAccess,
  kinds: AssetKindRegistry
) {
  const { clientInstanceId: _clientInstanceId, grantedBy, ...view } = grant;
  const asset =
    grant.scopeKind === "asset" ? context.scopeAssets.get(grant.scopeId ?? "") : undefined;
  const readAction = asset && kinds.get(asset.kind)?.actions.read;
  const named =
    asset !== undefined && readAction !== undefined && access.authorize(readAction).allowed;
  return {
    ...view,
    ...(asset
      ? {
          scopeAsset: {
            kind: asset.kind,
            ...(named ? { name: asset.name } : {}),
            active: asset.active
          }
        }
      : {}),
    ...(context.hiddenUserIds.has(grantedBy) ? {} : { grantedBy })
  };
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
