import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";
import {
  PLATFORM_REPORT_NOTE_MARK,
  PlatformReportWorkflow,
  authorizePlatformReport
} from "./platform-report-service";

/**
 * "Problem an Workshape melden" (PLATFORM-REPORT). The note is treated as a secret of the call:
 * its run hashes the input with the note replaced by a mark and keeps no answer, and the call
 * is never held for an approval, where its input would be kept and shown to whoever decides.
 */
export function registerPlatformReportRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new PlatformReportWorkflow(options);
  route.operation(apiOperations["platform_report.send"], {
    // A mail to the operator that cannot be called back.
    changeClass: "outward",
    authorize: authorizePlatformReport,
    resource: ({ conversationId }) => ({ kind: "conversation", id: conversationId }),
    inputWithoutSecrets: (input) =>
      input.note ? { ...input, note: PLATFORM_REPORT_NOTE_MARK } : undefined,
    execute: ({ conversationId, runId, ...body }, context) =>
      workflow.send(context, conversationId, runId, body)
  });
}
