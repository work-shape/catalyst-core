import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError } from "@vivd-catalyst/core";
import type { Route } from "../http/route";
import type { ResolvedChatServerOptions } from "../types";
import { VIEW_SHELL_FILES, viewShellContentPolicy } from "../view-shell";

/**
 * How long a browser keeps the shell. The header carries `views.allowedScriptSrc`, which is
 * release config: a host added there reaches a browser that already holds the shell this much
 * later. A host removed is refused at once, by the view's own policy.
 */
const VIEW_SHELL_MAX_AGE_SECONDS = 300;

export function registerViewShellRoutes(
  route: Route,
  options: Pick<ResolvedChatServerOptions, "config">
): void {
  route(apiOperations["view_shell.files.get"], ({ params, request, reply }) => {
    const file = VIEW_SHELL_FILES.get(params.version)?.get(params.file);
    if (!file) {
      throw new AppError("NOT_FOUND", "View shell file not found");
    }
    // The document is a frame's and its script a script's, never a page of its own. A browser
    // says what a request is for; a client that does not say is answered, and gets nothing
    // from it that a frame would not.
    const fetchDestination = request.headers["sec-fetch-dest"];
    if (fetchDestination !== undefined && fetchDestination !== file.fetchDestination) {
      throw new AppError("FORBIDDEN", "The view shell is served to a frame only");
    }
    return (
      reply
        .header("content-type", file.contentType)
        .header(
          "content-security-policy",
          viewShellContentPolicy(options.config.views.allowedScriptSrc)
        )
        .header("cache-control", `public, max-age=${VIEW_SHELL_MAX_AGE_SECONDS}`)
        // The answer depends on what the request is for, so a cache keeps one per destination.
        .header("vary", "Sec-Fetch-Dest")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        // The shell has no origin of its own, so the load of its script is cross-origin.
        .header("cross-origin-resource-policy", "cross-origin")
        .send(file.body)
    );
  });
}
