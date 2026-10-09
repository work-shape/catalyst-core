import { apiOperations } from "@vivd-catalyst/api-contract";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/**
 * Development inspection route for the capture mail provider. It is only registered when
 * mails are captured instead of delivered, which release config validation only accepts for
 * development client instances.
 */
export function registerDevMailRoutes(route: Route, options: ChatServerOptions): void {
  const listCaptured = options.mail?.listCaptured;
  if (!listCaptured) {
    return;
  }
  route(apiOperations.listCapturedMail, () => listCaptured());
}
