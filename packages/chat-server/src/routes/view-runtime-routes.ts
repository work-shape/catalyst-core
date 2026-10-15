import { apiOperations } from "@work-shape/catalyst-api-contract";
import { AppError } from "@work-shape/catalyst-core";
import { loadAppKitFiles } from "../app-kit-runtime";
import type { Route } from "../http/route";
import { loadViewRuntimeFiles } from "../view-runtime";

export function registerViewRuntimeRoutes(route: Route): void {
  const files = loadViewRuntimeFiles();

  route(apiOperations["view_runtime.files.get"], ({ params, reply }) => {
    const file = files.get(params.version)?.get(params.file);
    if (!file) {
      throw new AppError("NOT_FOUND", "View runtime file not found");
    }
    return (
      reply
        .header("content-type", file.contentType)
        .header("content-length", String(file.bytes.byteLength))
        // An address never changes its content, so a browser keeps it for good.
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        // The frame of a view has no origin of its own: every load of these files is cross-origin.
        .header("cross-origin-resource-policy", "cross-origin")
        .send(file.bytes)
    );
  });

  const kitVersions = loadAppKitFiles();

  route(apiOperations["app_kit.files.get"], ({ params, request, reply }) => {
    const kit = kitVersions.get(params.version);
    if (!kit) {
      // A Page names the kit version it was built with. This release does not hold it.
      throw new AppError("NOT_FOUND", "This App Kit version is not available", {
        reason: "kit_unavailable"
      });
    }
    const file = kit.get(wildcardOf(request.params));
    if (!file) {
      throw new AppError("NOT_FOUND", "App Kit file not found", { reason: "kit_file_unknown" });
    }
    return (
      reply
        .header("content-type", file.contentType)
        .header("content-length", String(file.bytes.byteLength))
        // A released version is frozen, so a browser keeps a file for good.
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        // The frame of a Page has no origin: it loads these files across origins, and a module
        // script is asked for in CORS mode without credentials.
        .header("cross-origin-resource-policy", "cross-origin")
        .header("access-control-allow-origin", "*")
        .send(file.bytes)
    );
  });
}

/** What the route's wildcard matched: the file name after the version. */
function wildcardOf(params: unknown): string {
  const value: unknown =
    typeof params === "object" && params !== null ? Reflect.get(params, "*") : undefined;
  return typeof value === "string" ? value : "";
}
