import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError } from "@vivd-catalyst/core";
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
}
