import { createHash } from "node:crypto";
import {
  apiOperations,
  createOpenApiDocumentFromOperations,
  renderApiReferencePage,
  type OpenApiDocument
} from "@vivd-catalyst/api-contract";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/**
 * The reference of this instance: the document of the operations it registered, so what it
 * runs without is absent, and the same document as a page. The page holds one style element
 * and no script, and its content policy lets it load nothing.
 */
export function registerApiReferenceRoutes(route: Route, options: ChatServerOptions): void {
  let described: { operations: number; document: OpenApiDocument } | undefined;
  // Read on a call, not here: operations registered after this one belong to the document too.
  const instanceDocument = (): OpenApiDocument => {
    if (described?.operations !== route.registered.length) {
      described = {
        operations: route.registered.length,
        document: createOpenApiDocumentFromOperations(
          Object.fromEntries(route.registered.map((operation) => [operation.id, operation]))
        )
      };
    }
    return described.document;
  };

  route(apiOperations["openapi.get"], () => instanceDocument());

  route(apiOperations["docs.get"], ({ reply }) => {
    const { ui } = options.config;
    const page = renderApiReferencePage(instanceDocument(), {
      documentHref: apiOperations["openapi.get"].buildPath(),
      theme:
        ui.defaultThemeMode === "light"
          ? { light: ui.theme }
          : ui.defaultThemeMode === "dark"
            ? { light: ui.darkTheme }
            : { light: ui.theme, dark: ui.darkTheme }
    });
    const styleHash = createHash("sha256").update(page.styleSheet).digest("base64");
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header(
        "content-security-policy",
        `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      )
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .send(page.html);
  });
}
