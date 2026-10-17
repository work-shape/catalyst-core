import { isConnectionOAuthCallbackPath } from "@work-shape/catalyst-core";

/**
 * Whether a request is the callback of a Connection's sign-in, whose address holds the code
 * and the state the provider sent. Such a request is never logged.
 */
export function holdsSignInCallback(request: { url?: string }): boolean {
  const path = request.url?.split("?", 1)[0];
  return path !== undefined && isConnectionOAuthCallbackPath(path);
}
