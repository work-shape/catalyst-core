import { apiOperations } from "@work-shape/catalyst-api-contract";
import { isAuthenticatedServicePrincipal } from "@work-shape/catalyst-core";
import type { Route } from "../http/route";
import type { ResolvedChatServerOptions } from "../types";
import {
  listOwnOperationSettings,
  recordOperationSettingChanged,
  setOwnOperationSetting,
  type OperationSettingsDeps
} from "../users/operation-settings-service";

/** What the settings are read and checked with: the instance's operations and its policy. */
export function operationSettingsDeps(options: ResolvedChatServerOptions): OperationSettingsDeps {
  return {
    clientInstanceId: options.clientInstanceId,
    stores: options.stores,
    registry: options.operationCalls.registry,
    policy: options.operationCalls.deps.policy,
    ...(options.operations?.now ? { now: options.operations.now } : {})
  };
}

/**
 * You > Confirmations (OP-6): a person's own Always allow, Ask me or Never per operation. Only
 * the person signed in themself reads and sets their own; no key carries the scope that sets
 * one, no agent holds it as a tool, and a call from anywhere but the interface is refused.
 */
export function registerOperationSettingRoutes(
  route: Route,
  options: ResolvedChatServerOptions
): void {
  const deps = operationSettingsDeps(options);
  const setOwn = apiOperations["me.operation_settings.set"];

  route(apiOperations["me.operation_settings.list"], ({ user }) =>
    listOwnOperationSettings(deps, user)
  );

  route.operation(setOwn, {
    // A setting is changed back as easily as it was set.
    changeClass: "reversible",
    authorize: (_input, { actor, origin }) =>
      isAuthenticatedServicePrincipal(actor) ||
      actor.delegatedActor !== undefined ||
      origin.kind !== "user"
        ? {
            allowed: false,
            action: setOwn.id,
            reason: "no_grant",
            message: "Only a person signed in themself sets their own confirmations"
          }
        : { allowed: true },
    async execute({ operation, value }, context) {
      const { view, changed } = await setOwnOperationSetting(deps, {
        actor: context.actor,
        operation,
        value
      });
      if (changed) {
        await recordOperationSettingChanged(context.audit, {
          actor: context.actor,
          correlationId: context.correlationId,
          operation,
          value
        });
      }
      return view;
    }
  });
}
