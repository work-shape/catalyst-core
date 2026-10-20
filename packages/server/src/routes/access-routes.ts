import {
  authorizePrincipalHolderWrite,
  holderNotAdministrable,
  requireManageableHolder
} from "../access/grant-holder-rules";
import { requireAuthorized, withRightsHeld } from "../access/rights-held";
import {
  auditActorFromUser,
  asUserId,
  resolveDataScope,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  isAuthenticatedServicePrincipal,
  type ActorAccess,
  type AssetKindRegistry,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { AccessWorkflow, type GrantViewContext } from "../access/access-service";
import type { Route } from "../http/route";
import { requirePathParam } from "./request-context";
import type { ChatServerOptions } from "../types";

/**
 * Governance records. The three changing operations are operations of the registry: each
 * call is an Operation Run, and the caller's right is asked before the policy. The three reads
 * are plain routes.
 */
export function registerAccessRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new AccessWorkflow(options);
  const requireHolder = async (
    stores: PlatformStores,
    actor: AuthenticatedUser,
    holder: { holderKind: string; holderId: string }
  ) => {
    if (holder.holderKind !== "user") return;
    const person = await stores.users.getUser({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(holder.holderId)
    });
    if (!person) throw new AppError("NOT_FOUND", "User not found");
    requireManageableHolder(actor, person);
  };
  route(apiOperations["scope_assignments.list"], async ({ query, user }) => {
    await requireHolder(options.stores, personOf(user), query);
    const assignments = await options.stores.access.listScopeAssignments({
      clientInstanceId: options.clientInstanceId,
      ...query
    });
    const persisted =
      query.holderKind === "group"
        ? undefined
        : await options.stores.access.loadPersistedAccess({
            clientInstanceId: options.clientInstanceId,
            holder: { kind: query.holderKind, id: query.holderId }
          });
    const inherited =
      query.holderKind === "group"
        ? assignments
        : persisted?.holderActive
          ? (persisted.scopeAssignments ?? [])
          : [];
    const effective: Record<string, "all" | string[]> = {};
    for (const dimension of Object.keys(options.config.scopes ?? {})) {
      const scope = resolveDataScope(inherited, dimension);
      effective[dimension] = scope === "all" ? scope : [...scope];
    }
    return { dimensions: options.config.scopes ?? {}, assignments, effective };
  });
  route.operation(apiOperations["scope_assignments.set"], {
    resource: ({ holderKind, holderId }) => ({ kind: holderKind, id: holderId }),
    changeClass: "reversible",
    async execute(input, context) {
      const actor = personOf(context.actor);
      if (!options.config.scopes?.[input.dimension])
        throw new AppError("VALIDATION_FAILED", "This data scope is not declared", {
          reason: "scope_dimension_unknown"
        });
      await withRightsHeld(
        options,
        {
          actor,
          access: context.access,
          ...(input.holderKind === "user" ? { userId: input.holderId } : {})
        },
        async (held) => {
          // As for grants (check 41): nobody writes or lifts their own assignment, also not
          // through a group they belong to, and a principal's row is its administrators'.
          held.access.require("users.manage");
          if (input.holderKind === "service_principal") {
            requireAuthorized(
              authorizePrincipalHolderWrite(held.actor, held.access, "scope_assignments.set")
            );
          } else {
            const own =
              input.holderKind === "user"
                ? input.holderId === held.actor.id
                : (
                    await held.options.stores.users.getUser({
                      clientInstanceId: options.clientInstanceId,
                      userId: asUserId(held.actor.id)
                    })
                  )?.groups?.includes(input.holderId);
            if (own)
              requireAuthorized(
                holderNotAdministrable(
                  "scope_assignments.set",
                  "Nobody writes or lifts a data assignment of their own: another holder of the right does"
                )
              );
          }
          await requireHolder(held.options.stores, held.actor, input);
          await held.options.stores.access.setScopeAssignment({
            ...input,
            clientInstanceId: options.clientInstanceId
          });
        }
      );
      await context.audit.record({
        type: "scope_assignment.changed",
        actor: auditActorFromUser(actor),
        status: "success",
        subject: input.holderId,
        correlationId: context.correlationId,
        metadata: {
          dimension: input.dimension,
          holderKind: input.holderKind,
          effect: input.effect,
          all: input.values === "all",
          valueCount: input.values === "all" ? 0 : input.values.length
        }
      });
      return input;
    }
  });
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

  route(apiOperations["workspaces.limits.list"], async () =>
    (await workflow.listWorkspaceLimits()).map(workspaceLimitsView)
  );

  route.operation(apiOperations["workspaces.limits.update"], {
    resource: ({ collaborationWorkspaceId }) => ({
      kind: "collaboration_workspace",
      id: collaborationWorkspaceId
    }),
    changeClass: "reversible",
    execute: async ({ collaborationWorkspaceId, ...lists }, context) =>
      workspaceLimitsView(
        await workflow.updateWorkspaceLimits(personOf(context.actor), context, {
          collaborationWorkspaceId: asCollaborationWorkspaceId(
            requirePathParam(collaborationWorkspaceId, "Missing workspace id")
          ),
          ...lists
        })
      )
  });
}

/** A workspace as Instance > Workspaces shows it: its name and its build limits. */
function workspaceLimitsView(workspace: CollaborationWorkspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    allowedToolNames: workspace.allowedToolNames ?? null,
    allowedModelBindingIds: workspace.allowedModelBindingIds ?? null
  };
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
