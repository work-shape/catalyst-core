import { z } from "zod";
import { defineJobKind } from "./jobs";
import type {
  ServerPreviewCaptureInput,
  ServerPreviewCaptureOutcome
} from "@work-shape/catalyst-asset-schemas";

/** SRV-1 grants no authority to read or change App data. */
export interface PreviewCaptureService {
  capture(input: ServerPreviewCaptureInput): Promise<ServerPreviewCaptureOutcome>;
}
/** Two default renderer slots plus four requests waiting in the service. */
export const SERVER_PREVIEW_CAPTURE_JOB_SLOTS = 6;
export const serverPreviewCaptureJob = defineJobKind({
  kind: "preview.capture",
  payloadSchema: z.object({ captureId: z.string().min(1) }),
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 30_000,
  concurrency: { global: SERVER_PREVIEW_CAPTURE_JOB_SLOTS, perKey: 1 },
  manualRetry: false
});
