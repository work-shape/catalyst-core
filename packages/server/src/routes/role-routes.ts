import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { RoleGrant } from "@work-shape/catalyst-core";
import { RoleWorkflow, type RoleView } from "../access/role-service";
import type { Route } from "../http/route";
import { requirePathParam } from "./request-context";
import type { ChatServerOptions } from "../types";

/**
 * Instance > Access > Roles (ADR-0028). The two reads are plain routes behind `users.manage`.
 * The five writes are registered operations: each call is an Operation Run, and the role rules
 * are asked before the policy and again where the write happens.
 */
export function registerRoleRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new RoleWorkflow(options);
  const create = apiOperations["roles.create"];
  const update = apiOperations["roles.update"];
  const remove = apiOperations["roles.delete"];
  const reset = apiOperations["roles.reset"];
  const decide = apiOperations["roles.pending.decide"];
  const resource = ({ roleId }: { roleId: string }) => ({ kind: "role", id: roleId });

  route(apiOperations["roles.list"], async () => ({
    items: (await workflow.list()).map(roleView)
  }));

  route(apiOperations["roles.get"], async ({ params }) =>
    roleView(await workflow.get(requirePathParam(params.roleId, "Missing role id")))
  );

  route.operation(create, {
    changeClass: "reversible",
    authorize: (input, { actor, access }) =>
      workflow.authorizeWrite(actor, access, create.id, { grants: input.grants }),
    execute: async (input, context) => roleView(await workflow.create(create.id, context, input))
  });

  route.operation(update, {
    changeClass: "reversible",
    authorize: (input, { actor, access }) =>
      workflow.authorizeWrite(actor, access, update.id, {
        roleId: input.roleId,
        ...(input.grants === undefined ? {} : { grants: input.grants })
      }),
    resource,
    execute: async (input, context) =>
      roleView(
        await workflow.update(update.id, context, roleIdParam(input), {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.grants === undefined ? {} : { grants: input.grants })
        })
      )
  });

  route.operation(remove, {
    changeClass: "reversible",
    // Deleting takes every grant of the role away, so it is asked as a change to none.
    authorize: (input, { actor, access }) =>
      workflow.authorizeWrite(actor, access, remove.id, { roleId: input.roleId, grants: [] }),
    resource,
    execute: async (input, context) =>
      roleView(await workflow.delete(remove.id, context, roleIdParam(input)))
  });

  route.operation(reset, {
    changeClass: "reversible",
    authorize: (input, { actor, access }) =>
      workflow.authorizeWrite(actor, access, reset.id, { roleId: input.roleId }),
    resource,
    execute: async (input, context) =>
      roleView(await workflow.reset(reset.id, context, roleIdParam(input)))
  });

  route.operation(decide, {
    changeClass: "reversible",
    // Deciding for a built-in role is editing it: `roles.edit_built_in` beside `users.manage`.
    authorize: (input, { actor, access }) =>
      workflow.authorizeWrite(actor, access, decide.id, { roleId: input.roleId }),
    resource,
    execute: async (input, context) =>
      roleView(
        await workflow.decidePending(decide.id, context, roleIdParam(input), {
          action: input.action,
          decision: input.decision
        })
      )
  });
}

function roleIdParam(params: { roleId: string }): string {
  return requirePathParam(params.roleId, "Missing role id");
}

/** The role on the wire: without the instance and the default it was reconciled with. */
function roleView(role: RoleView) {
  return {
    id: role.id,
    name: role.name,
    ...(role.description === undefined ? {} : { description: role.description }),
    builtIn: role.builtIn,
    editable: role.editable,
    grants: role.grants.map(grantView),
    ...(role.defaultGrants === undefined
      ? {}
      : { defaultGrants: role.defaultGrants.map(grantView) }),
    ...(role.equalsDefault === undefined ? {} : { equalsDefault: role.equalsDefault }),
    pendingActions: role.pendingActions
  };
}

function grantView(grant: RoleGrant) {
  return {
    action: grant.action,
    effect: grant.effect,
    scopeKind: grant.scopeKind,
    ...(grant.scopeId === undefined ? {} : { scopeId: grant.scopeId })
  };
}
