import {
  AppError,
  serverPreviewCaptureOutcomeSchema,
  type SecretResolver,
  type PreviewCaptureService
} from "@work-shape/catalyst-core";
import type { ClientInstanceEnv } from "../env";
/** Only the API gets this client. Off unless explicitly enabled; the tool stays on PREVIEW-SEE-1. */
export async function createInstancePreviewCaptureClient(
  env: ClientInstanceEnv,
  secrets: SecretResolver
): Promise<PreviewCaptureService | undefined> {
  if (env.PREVIEW_CAPTURE_ENABLED !== "true") return undefined;
  const token = await secrets.resolve("PREVIEW_CAPTURE_SERVICE_TOKEN");
  const url = new URL(env.PREVIEW_CAPTURE_SERVICE_ORIGIN ?? "http://preview-capture:4120");
  if (
    !token ||
    token.length < 32 ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new AppError(
      "VALIDATION_FAILED",
      "PREVIEW_CAPTURE_SERVICE_TOKEN (at least 32 characters) and a service origin are required when PREVIEW_CAPTURE_ENABLED is true"
    );
  return {
    async capture(input) {
      try {
        const response = await fetch(new URL("/capture", url), {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, input.deadline - Date.now())))
        });
        if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 600_000)
          throw new Error("Capture failed");
        const body = await response.text();
        if (body.length > 600_000) throw new Error("Capture failed");
        return serverPreviewCaptureOutcomeSchema.parse(JSON.parse(body));
      } catch {
        return { status: "refused", code: "capture_failed" };
      }
    }
  };
}
