import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  isAuthenticatedServicePrincipal,
  type ActorAccess,
  type AssetKindRegistry,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type Namespace,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { AccessWorkflow, type GrantViewContext } from "../access/access-service";
import type { Route } from "../http/route";
import { requirePathParam } from "./request-context";
import type { ChatServerOptions } from "../types";

/**
 * Governance records. The five changing operations are operations of the registry: each call
 * is an Operation Run, and the caller's right is asked before the policy. The three reads are
 * plain routes.
 */
export function registerAccessRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new AccessWorkflow(options);
  const { kinds } = options.configAssets;
  const grant = apiOperations["permissions.grant"];
  const revoke = apiOperations["permissions.revoke"];

  route.operation(grant, {
    authorize: (input, { actor, access }) =>
      workflow.authorizeGrant(actor, access, grant.id, input),
    resource: ({ holderKind, holderId }) => ({ kind: holderKind, id: holderId }),
    changeClass: "reversible",
    execute: async (input, context) => {
      const user = personOf(context.actor);
      const written = await workflow.grant(user, context, input);
      return grantView(
        written,
        await workflow.grantViewContext(user, [written]),
        context.access,
        kinds
      );
    }
  });

  route.operation(revoke, {
    authorize: ({ grantId }, { actor, access }) =>
      workflow.authorizeRevoke(actor, access, revoke.id, grantId),
    // The call names the row. Its holder is in the row and in the audit event of the revoke.
    resource: ({ grantId }) => ({ kind: "permission_grant", id: grantId }),
    changeClass: "reversible",
    execute: async ({ grantId }, context) => {
      const user = personOf(context.actor);
      const removed = await workflow.revoke(
        user,
        context,
        requirePathParam(grantId, "Missing grant id")
      );
      return grantView(
        removed,
        await workflow.grantViewContext(user, [removed]),
        context.access,
        kinds
      );
    }
  });

  route(apiOperations["permissions.list"], async ({ user, access, query, paging }) => {
    const grants = await workflow.listGrants(user, access, {
      holderKind: query.holderKind,
      holderId: query.holderId,
      action: query.action,
      scopeKind: query.scopeKind,
      scopeId: query.scopeId,
      page: paging
    });
    const view = await workflow.grantViewContext(user, grants);
    return grants.map((grant) => grantView(grant, view, access, kinds));
  });

  route(apiOperations["permissions.effective"], ({ user, access, query }) =>
    workflow.effective(user, access, query)
  );

  route.operation(apiOperations["namespaces.create"], {
    resource: namespaceResource,
    changeClass: "reversible",
    execute: async (input, context) => {
      const user = personOf(context.actor);
      return namespaceView(
        await workflow.createNamespace(user, context, input),
        await workflow.hiddenUserIds(user)
      );
    }
  });

  route.operation(apiOperations["namespaces.update"], {
    resource: namespaceResource,
    changeClass: "reversible",
    execute: async (input, context) => {
      const user = personOf(context.actor);
      return namespaceView(
        await workflow.updateNamespace(user, context, { ...input, prefix: prefixParam(input) }),
        await workflow.hiddenUserIds(user)
      );
    }
  });

  route(apiOperations["namespaces.list"], async ({ user }) => {
    const hidden = await workflow.hiddenUserIds(user);
    return (await workflow.listNamespaces()).map((namespace) => ({
      ...namespaceView(namespace, hidden),
      grantCount: namespace.grantCount,
      assetCount: namespace.assetCount
    }));
  });

  route.operation(apiOperations["namespaces.delete"], {
    resource: namespaceResource,
    changeClass: "reversible",
    execute: async (input, context) => {
      const user = personOf(context.actor);
      return namespaceView(
        await workflow.deleteNamespace(user, context, prefixParam(input)),
        await workflow.hiddenUserIds(user)
      );
    }
  });
}

/**
 * The person behind a call. The operations here authenticate a person, so a service principal
 * is turned away before it reaches one; this refuses one that arrived around that.
 */
function personOf(actor: AuthenticatedIdentity): AuthenticatedUser {
  if (isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", "Service principals cannot access user-scoped routes");
  }
  return actor;
}

function namespaceResource(input: { prefix: string }) {
  return { kind: "namespace", id: input.prefix };
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
