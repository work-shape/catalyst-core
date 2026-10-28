import {
  serverPreviewCaptureInputSchema,
  type ServerPreviewCaptureInput,
  type ServerPreviewCaptureOutcome
} from "@work-shape/catalyst-asset-schemas";
export const captureInputSchema = serverPreviewCaptureInputSchema;
export type CaptureInput = ServerPreviewCaptureInput;
export type CaptureOutcome = ServerPreviewCaptureOutcome;
export type BlockedRequest = Extract<CaptureOutcome, { status: "done" }>["blocked"][number];
export const CAPTURE_MS = 20_000;
export const QUEUE_MS = 10_000;
export const MAX_WAITING = 4;
export const IDLE_MS = 180_000;
export const RECYCLE_AFTER = 200;
export const MAX_IMAGE_BYTES = 400_000;
// One renderer may use this much resident memory; it leaves room for Node, the browser,
// the host renderer and shared memory inside the one-slot 512 MiB container.
export const RENDERER_MAX_RSS_KIB = 192 * 1024;
export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 }
};

/** Both origins are operator configuration, never input from an App or a capture caller. */
export function forwardedPath(
  method: string,
  raw: string,
  origin: string,
  prefix: string
): string | undefined {
  const url = new URL(raw);
  if (
    method !== "GET" ||
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined;
  // Reject encoded path separators and dots before URL/path normalization can change scope.
  if (/%(?:2e|2f|5c|00)/iu.test(url.pathname) || url.pathname.includes("\\")) return undefined;
  if (
    url.pathname.startsWith(prefix) ||
    /^\/app-runtime\/kit\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/.test(url.pathname)
  )
    return url.pathname;
  return undefined;
}
