import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  asConversationId,
  auditActorFromUser,
  getSubjectUserId,
  requireAuthScope,
  type AuthenticatedUser
} from "@work-shape/catalyst-core";
import {
  requireConversationReach,
  workspaceOfConversation
} from "../conversations/conversation-access";
import { readMultipartFile } from "../http/multipart-upload";
import type { Route } from "../http/route";
import { requireProjectAccess } from "../projects/project-access";
import { resolveRequestLocale } from "../routes/request-context";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceToWorkIn } from "../workspaces/workspace-access";
import { transcriptionTerms, type TranscriptionPlace } from "./transcription-terms";

/** The largest recording a request carries: five minutes of compressed speech fit well within. */
const TRANSCRIPTION_MAX_BYTES = 10 * 1024 * 1024;

/** How long one transcription may take, its retries included. */
const TRANSCRIPTION_DEADLINE_MS = 120_000;

/**
 * The audio formats a recording may come in, by their base media type, each with the name the
 * provider reads its format from: what Chrome and Firefox record (WebM/Opus), what Safari
 * records (MP4/AAC), and Ogg, WAV and MPEG audio.
 */
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/mp4": "mp4",
  "video/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3"
};

/**
 * Speech to text in the composer (STT-1): a recording in, its text out. The audio is held in
 * memory for this request alone and is never written to disk, storage, the database or a log;
 * the text is returned and not stored. One minimized audit event records the binding and the
 * seconds, never audio, text or terms.
 */
export function registerTranscriptionRoutes(route: Route, options: ChatServerOptions): void {
  route(
    apiOperations["transcriptions.create"],
    async ({ user, access, context, query, request }) => {
      // As for sending a message: the descriptor carries one scope, this is the second.
      requireAuthScope(user, "run:start");
      const binding = options.config.modelBindings.find(
        (candidate) => candidate.kind === "transcription"
      );
      const transcribe = options.modelGateway.transcribe?.bind(options.modelGateway);
      if (!binding || !transcribe) {
        throw new AppError("NOT_FOUND", "Speech to text is not available on this instance");
      }
      const place = await placeOf(options, user, query);
      const part = await readMultipartFile(request, TRANSCRIPTION_MAX_BYTES);
      if (!part) throw new AppError("VALIDATION_FAILED", "A recording is required");
      const mimeType = (part.mimetype.split(";")[0] ?? "").trim().toLowerCase();
      const format = AUDIO_FORMATS[mimeType];
      if (!format) {
        part.file.resume();
        throw new AppError(
          "VALIDATION_FAILED",
          "The recording is in no audio format speech to text takes",
          { reason: "transcription_format" },
          { exposeMessage: true }
        );
      }
      // In memory only: the recording never touches the disk.
      const bytes = await part.toBuffer();
      if (part.file.truncated) {
        throw new AppError(
          "VALIDATION_FAILED",
          "The recording is larger than speech to text takes",
          { reason: "transcription_too_large" },
          { exposeMessage: true }
        );
      }
      if (bytes.byteLength === 0) {
        throw new AppError("VALIDATION_FAILED", "The recording is empty", {
          reason: "transcription_empty"
        });
      }
      const locale = resolveRequestLocale(options, request);
      const terms = await transcriptionTerms(options, { access, locale, place });
      const result = await transcribe({
        binding: { bindingId: binding.id },
        audio: { bytes, mimeType, filename: `recording.${format}` },
        language: query.language ?? languageOf(locale),
        terms,
        attribution: {
          kind: "system",
          purpose: "transcription",
          userId: getSubjectUserId(user),
          ...(place.workspace ? { workspaceId: place.workspace.id } : {}),
          ...(place.conversationId ? { conversationId: place.conversationId } : {})
        },
        clientInstanceId: options.clientInstanceId,
        correlationId: context.correlationId,
        deadline: new Date(Date.now() + TRANSCRIPTION_DEADLINE_MS)
      });
      await options.auditRecorder.record({
        type: "transcription.completed",
        status: "success",
        actor: auditActorFromUser(user),
        subject: binding.id,
        correlationId: context.correlationId,
        metadata: { bindingId: binding.id, durationSeconds: result.durationSeconds }
      });
      return result;
    }
  );
}

/**
 * Where the composer is: the chat, else the project, else the workspace the request names,
 * each as the person may reach it. A place the person may not reach answers as one that does
 * not exist.
 */
async function placeOf(
  options: ChatServerOptions,
  user: AuthenticatedUser,
  query: { conversationId?: string; projectId?: string; workspaceId?: string }
): Promise<TranscriptionPlace & { conversationId?: ReturnType<typeof asConversationId> }> {
  if (query.conversationId !== undefined) {
    const conversationId = asConversationId(query.conversationId);
    const { conversation, outside } = await requireConversationReach(options, conversationId, user);
    const workspace = await workspaceOfConversation(options, conversation);
    const project =
      conversation.projectId === undefined || outside
        ? undefined
        : await requireProjectAccess(options, user, conversation.projectId).catch(() => undefined);
    return {
      conversationId,
      workspace,
      ...(project ? { project } : {}),
      ...(outside ? { outside } : {})
    };
  }
  if (query.projectId !== undefined) {
    const project = await requireProjectAccess(options, user, query.projectId);
    const workspace = await options.stores.workspaces.getWorkspace(
      options.clientInstanceId,
      project.collaborationWorkspaceId
    );
    return { project, ...(workspace ? { workspace } : {}) };
  }
  if (query.workspaceId !== undefined) {
    const workspaceId = asCollaborationWorkspaceId(query.workspaceId);
    await requireWorkspaceToWorkIn(options, user, workspaceId);
    const workspace = await options.stores.workspaces.getWorkspace(
      options.clientInstanceId,
      workspaceId
    );
    if (!workspace) throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    return { workspace };
  }
  return {};
}

/** The language of a locale such as `de` or `de-AT`, as an ISO 639-1 code. */
function languageOf(locale: string): string {
  return (locale.split("-")[0] ?? locale).toLowerCase();
}
