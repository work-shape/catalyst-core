import { appBridgePageMessageSchema } from "@work-shape/catalyst-api-contract";
import {
  boundPreviewReport,
  scrubPreviewText,
  unknownToJsonValue,
  isJsonObject,
  serverPreviewCaptureOutcomeSchema
} from "@work-shape/catalyst-core";

import { createHash } from "node:crypto";
import {
  AppError,
  asAgentRunId,
  asUserId,
  asCollaborationWorkspaceId,
  authenticatedUserFromRecord,
  claimSubjectRow,
  defineJobHandler,
  isPreviewCaptureWithinBounds,
  previewCaptureObjectPrefix,
  PREVIEW_CAPTURE_ARTIFACT_SOURCE,
  PREVIEW_CAPTURES_PER_RUN,
  PREVIEW_CAPTURES_PER_HOUR,
  serverPreviewCaptureJob,
  SERVER_PREVIEW_CAPTURE_JOB_SLOTS,
  type ServerPreviewCaptureRow,
  type ServerPreviewCaptureSettings,
  type RegisteredJobHandler,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { ConversationWorkflow } from "../conversations/conversation-service";
import { accessResource } from "../assets/asset-access";
import { appContentPath, mintAppContentToken, type AppContentClaims } from "../pages/app-content";

// Dark SRV-1 entry point. No HTTP route or tool starts a capture. A future tool calls this
// from its live run, whether it executes in the API or a separate worker, without a content key.
export async function requestServerPreviewCapture(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores">,
  input: {
    runId: string;
    toolCallId: string;
    size?: ServerPreviewCaptureSettings["size"];
    theme?: ServerPreviewCaptureSettings["theme"];
  }
) {
  const { clientInstanceId, stores } = options;
  const run = await stores.agentRuns.getAgentRun({
    clientInstanceId,
    runId: asAgentRunId(input.runId)
  });
  if (
    !run?.ownerUserId ||
    run.status !== "running" ||
    run.principalId ||
    run.authorization?.principal.kind !== "user" ||
    run.authorization.delegatedActor
  )
    throw unavailable();
  // A Page's saved revisions are the revisions workspace.open opened in this conversation.
  // Another person's preview report never chooses the target or whose rights are checked.
  const pages = await stores.pages.listPages({
    clientInstanceId,
    conversationId: run.conversationId
  });
  const revisions = await Promise.all(
    pages.map((page) => stores.pages.getPageFileSet({ clientInstanceId, pageId: page.id }))
  );
  const latest = revisions
    .filter((revision) => revision !== undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) throw unavailable();
  return stores.pages.requestPreviewCapture({
    clientInstanceId,
    conversationId: run.conversationId,
    userId: asUserId(run.ownerUserId),
    runId: run.id,
    toolCallId: input.toolCallId,
    fileSetId: latest.id,
    requestedAt: new Date().toISOString(),
    perRun: PREVIEW_CAPTURES_PER_RUN,
    perHour: PREVIEW_CAPTURES_PER_HOUR,
    server: {
      deadline: new Date(Date.now() + 20_000).toISOString(),
      size: input.size ?? "desktop",
      theme: input.theme ?? "light"
    }
  });
}
function unavailable() {
  return new AppError("FORBIDDEN", "Server preview capture is not available");
}

/** Checked on every file request, outside the ordinary viewer-access cache. */
export async function captureAddressActive(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores">,
  claims: AppContentClaims,
  now = Date.now()
): Promise<boolean> {
  if (!claims.pageSessionId.startsWith("capture:")) return true;
  const row = await options.stores.pages.getServerPreviewCapture({
    clientInstanceId: options.clientInstanceId,
    id: claims.pageSessionId.slice("capture:".length)
  });
  return (
    !!row &&
    row.status === "answering" &&
    row.fileSetId === claims.fileSetId &&
    row.userId === claims.viewerId &&
    now < Date.parse(row.settings.deadline) + 5000 &&
    claims.expiresAt <= Math.floor(Date.parse(row.settings.deadline) / 1000) + 5
  );
}

export function createServerPreviewCaptureJobs(options: ChatServerOptions): RegisteredJobHandler[] {
  const service = options.pages?.previewCaptureService;
  const key = options.pages?.contentKey;
  const objects = options.pages?.objects;
  if (!service || !key || !objects || !options.modules.isEnabled("apps")) return [];
  const { clientInstanceId } = options;
  const finish = (
    row: ServerPreviewCaptureRow,
    outcome: Parameters<
      ChatServerOptions["stores"]["pages"]["finishServerPreviewCapture"]
    >[0]["outcome"]
  ) =>
    options.stores.pages.finishServerPreviewCapture({
      clientInstanceId,
      id: row.id,
      answeredAt: new Date().toISOString(),
      outcome
    });
  return [
    defineJobHandler({
      kind: serverPreviewCaptureJob,
      slots: SERVER_PREVIEW_CAPTURE_JOB_SLOTS,
      async run(job, control) {
        if (job.subject !== job.payload.captureId || job.concurrencyKey !== job.subject) return;
        const row = await claimSubjectRow(control, async (stores) => {
          const row = await stores.pages.claimServerPreviewCapture({
            clientInstanceId,
            id: job.payload.captureId,
            now: new Date().toISOString()
          });
          return row ? { status: "claimed" as const, row } : { status: "finished" as const };
        });
        if (!row) return;
        try {
          const run = await options.stores.agentRuns.getAgentRun({
            clientInstanceId,
            runId: asAgentRunId(row.runId)
          });
          if (
            !run ||
            run.status !== "running" ||
            run.ownerUserId !== row.userId ||
            run.conversationId !== row.conversationId ||
            run.principalId ||
            run.authorization?.principal.kind !== "user" ||
            run.authorization.delegatedActor ||
            run.authorization.subjectUserId !== row.userId ||
            Date.parse(row.settings.deadline) <= Date.now()
          )
            throw unavailable();
          const user = await options.stores.users.getUser({ clientInstanceId, userId: row.userId });
          const fileSet = await options.stores.pages.getServedFileSet({
            clientInstanceId,
            fileSetId: row.fileSetId
          });
          if (!user || user.status !== "active" || !fileSet) throw unavailable();
          const identity = authenticatedUserFromRecord({
            user,
            identity: user.identities[0] ?? {
              authSource: "preview-capture",
              externalUserId: user.id
            }
          });
          const conversation = await new ConversationWorkflow(options).requireConversationAccess(
            row.conversationId,
            identity
          );
          if (fileSet.asset) {
            const { asset } = fileSet;
            const kind = options.configAssets.kinds.get(asset.kind);
            const access = await options.authorizer?.forActor(identity);
            if (!kind || !access) throw unavailable();
            access.require(
              kind.actions.write,
              accessResource(
                asset.kind,
                asset.name,
                asset.workspaceId
                  ? {
                      kind: "workspace",
                      workspaceId: asCollaborationWorkspaceId(asset.workspaceId)
                    }
                  : { kind: "instance" },
                asset.id
              )
            );
            const subject = conversation.subject;
            if (
              !(subject?.kind === asset.kind && subject.name === asset.name) &&
              !(await options.stores.conversations.createdAsset({
                clientInstanceId,
                conversationId: row.conversationId,
                kind: asset.kind,
                name: asset.name
              }))
            )
              throw unavailable();
          } else if (fileSet.conversationId !== row.conversationId) throw unavailable();
          const session = `capture:${row.id}`;
          const deadline = Date.parse(row.settings.deadline);
          const token = mintAppContentToken(key, clientInstanceId, {
            fileSetId: row.fileSetId,
            viewerId: row.userId,
            pageSessionId: session,
            expiresAt: Math.floor(deadline / 1000) + 5,
            ...(fileSet.asset ? { mode: "draft" as const } : {})
          });
          const outcome = serverPreviewCaptureOutcomeSchema.parse(
            await service.capture({
              contentPath: appContentPath(row.fileSetId, token),
              themeColors:
                row.settings.theme === "dark"
                  ? options.config.ui.darkTheme
                  : options.config.ui.theme,
              session,
              deadline,
              size: row.settings.size,
              theme: row.settings.theme,
              locale: run.locale ?? "en",
              number: fileSet.number
            })
          );
          if (outcome.status === "refused") {
            await finish(row, outcome);
            return;
          }
          const bytes = new Uint8Array(Buffer.from(outcome.image, "base64"));
          const size = isPreviewCaptureWithinBounds(bytes);
          if (!size || control.signal.aborted || deadline <= Date.now()) throw unavailable();
          const stillRunning = await options.stores.agentRuns.getAgentRun({
            clientInstanceId,
            runId: run.id
          });
          if (stillRunning?.status !== "running") throw unavailable();
          const objectKey = `${previewCaptureObjectPrefix(row.conversationId)}${row.id}.webp`;
          await objects.put(objectKey, bytes, { contentType: "image/webp" });
          try {
            await control.transaction(async (stores) => {
              const artifact = await stores.files.createManagedArtifact({
                clientInstanceId,
                conversationId: row.conversationId,
                kind: "image.webp",
                objectKey,
                filename: `preview-${row.id}.webp`,
                mimeType: "image/webp",
                byteSize: bytes.byteLength,
                checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                metadata: {
                  source: PREVIEW_CAPTURE_ARTIFACT_SOURCE,
                  PREVIEW_CAPTURES_PER_RUN,
                  PREVIEW_CAPTURES_PER_HOUR,
                  purpose: "inspection",
                  fileSetId: row.fileSetId,
                  width: size.width,
                  height: size.height
                }
              });
              const written = await stores.pages.finishServerPreviewCapture({
                clientInstanceId,
                id: row.id,
                answeredAt: new Date().toISOString(),
                outcome: {
                  status: "captured",
                  artifactId: artifact.id,
                  ...size,
                  diagnostics: scrubCaptureDiagnostics(outcome)
                }
              });
              if (!written) throw unavailable();
            });
          } catch {
            await objects.deletePrefix(objectKey).catch(() => undefined);
            throw unavailable();
          }
        } catch {
          // Do not propagate provider exceptions: their URLs or statements may carry secrets.
          await finish(row, { status: "refused", code: "capture_failed" });
        }
      },
      async onExhausted(job, stores) {
        await stores.pages.finishServerPreviewCapture({
          clientInstanceId,
          id: job.payload.captureId,
          answeredAt: new Date().toISOString(),
          outcome: { status: "refused", code: "capture_failed" }
        });
      }
    })
  ];
}

function scrubCaptureDiagnostics(input: {
  report: unknown;
  blocked: { method: string; host: string; path: string }[];
  calls: { name: string; code: string }[];
}): JsonObject {
  const parsed = appBridgePageMessageSchema.safeParse({
    catalystBridge: 1,
    type: "report",
    report: input.report
  });
  const report =
    parsed.success && parsed.data.type === "report"
      ? boundPreviewReport({ ...parsed.data.report, loaded: true, bridge: "not_used" })
      : null;
  const diagnostics = unknownToJsonValue({
    data: "none",
    report,
    blocked: input.blocked.map((request) => ({
      method: request.method,
      host: scrubPreviewText(request.host),
      path: scrubPreviewText(request.path)
    })),
    calls: input.calls.map((call) => ({ name: scrubPreviewText(call.name), code: "not_available" }))
  });
  return isJsonObject(diagnostics) ? diagnostics : {};
}
