import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";
import {
  readOwnUsage,
  readUsageLimits,
  setUsageLimit,
  type UsageLimitsDeps
} from "./usage-limits-service";

/**
 * Spend limits at three levels (LU-2). `usage.limits.get` and `usage.limits.set` are registered
 * operations that require `limits.manage`, so the screen, the API and the CLI are refused alike
 * and each refusal is an audited Operation Run. `me.usage.get` is the person's own view.
 */
export function registerUsageLimitRoutes(route: Route, options: ChatServerOptions): void {
  const deps: UsageLimitsDeps = {
    clientInstanceId: options.clientInstanceId,
    stores: options.stores,
    usageGovernance: options.usageGovernance
  };

  route.operation(apiOperations["usage.limits.get"], {
    execute: () => readUsageLimits(deps)
  });

  route.operation(apiOperations["usage.limits.set"], {
    // A limit is set back as easily as it was set.
    changeClass: "reversible",
    execute: (input, context) =>
      setUsageLimit(deps, {
        level: input.level,
        ...(input.target === undefined ? {} : { target: input.target }),
        limits: input.limits,
        actor: context.actor,
        audit: context.audit,
        correlationId: context.correlationId
      })
  });

  route(apiOperations["me.usage.get"], ({ user, access, query }) =>
    readOwnUsage(deps, {
      actor: user,
      access,
      ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId })
    })
  );
}
