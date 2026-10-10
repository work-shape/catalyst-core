import { apiOperations } from "@vivd-catalyst/api-contract";
import type { Route } from "../http/route";
import { INFRASTRUCTURE_CHECK_INTERVAL_MS } from "../job-kinds";
import type { ChatServerOptions } from "../types";

/** Instance > Infrastructure: what the instance runs on. Nothing here changes a provider. */
export function registerInfrastructureRoutes(route: Route, options: ChatServerOptions): void {
  const { infrastructure } = options;
  // An API assembled without its providers has none to list and none to ask.
  const none = { items: [], checkIntervalSeconds: INFRASTRUCTURE_CHECK_INTERVAL_MS / 1000 };

  route(apiOperations["instance.infrastructure.get"], () => infrastructure?.get() ?? none);
  route(apiOperations["instance.infrastructure.check"], () => infrastructure?.checkNow() ?? none);
}
