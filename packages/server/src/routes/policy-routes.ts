import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { Route } from "../http/route";
import {
  readPolicies,
  recordAlwaysAllowLockChanged,
  recordPolicySettingChanged,
  setAlwaysAllowLock,
  setPolicySetting
} from "../operations/policy-settings-service";
import type { ResolvedChatServerOptions } from "../types";

/**
 * Instance > Policies (OP-2). The three are registered operations that require
 * `policy.manage`, so the screen and any client are refused alike, and each refusal and each
 * change is an audited Operation Run.
 */
export function registerPolicyRoutes(route: Route, options: ResolvedChatServerOptions): void {
  route.operation(apiOperations["policies.get"], {
    execute: () => readPolicies(options)
  });

  route.operation(apiOperations["policies.set"], {
    // A setting is set back as easily as it was set.
    changeClass: "reversible",
    async execute(input, context) {
      const changed = await setPolicySetting(options, input);
      if (changed.previous !== (input.value ?? undefined)) {
        await recordPolicySettingChanged(context.audit, {
          actor: context.actor,
          correlationId: context.correlationId,
          request: input,
          previous: changed.previous
        });
      }
      return changed;
    }
  });

  route.operation(apiOperations["policies.set_always_allow_lock"], {
    changeClass: "reversible",
    async execute(input, context) {
      const changed = await setAlwaysAllowLock(options, input);
      if (changed.wasLocked !== changed.locked) {
        await recordAlwaysAllowLockChanged(context.audit, {
          actor: context.actor,
          correlationId: context.correlationId,
          operation: input.operation,
          locked: input.locked
        });
      }
      return changed;
    }
  });
}
