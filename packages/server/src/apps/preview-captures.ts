import { createHash } from "node:crypto";
import { compiledActionsOf, type CompiledAppAction } from "@work-shape/catalyst-app-build";
import {
  AppError,
  asConversationId,
  asUserId,
  connectionOperationName,
  getSubjectUserId,
  isFileSetId,
  isPreviewCaptureWithinBounds,
  PREVIEW_CAPTURE_ARTIFACT_SOURCE,
  PREVIEW_CAPTURE_WAIT_MS,
  previewCaptureObjectPrefix,
  type ActorAccess,
  type AuthenticatedUser,
  type FileSetId,
  type PagesStore
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import type { ResolvedChatServerOptions } from "../types";
import type { AppActionCalls, FrameSessionProof } from "./action-call";
import { frameConversation } from "./preview-reports";

// A picture of a preview, taken on a run's request (PREVIEW-SEE-1). The run asks the browser of
// the person whose turn it serves; the interface of that person learns of the request when it
// sees the run call the tool, asks here for its own pending requests, and answers with a picture
// of the preview its frame shows. No server renders anything.
//
// Only that person can answer, only from a frame of the revision the request names, in that
// conversation, and only once: the frame's proof names its viewer, and the request names the
// person and the revision. Another member's browser sees the run too, but finds no request of
// its own and can answer none. A preview that reaches data through a personal connection is
// refused, because the picture would carry that person's data into the run's work.
//
// The picture is an artifact of the conversation, kept under its retention and removed with it.
// It is no governance event: no audit event, Operation Run or log line holds it or its request.

/** How long after the request an answer is taken: the run's wait, and time to store it. */
const ANSWER_WINDOW_MS = PREVIEW_CAPTURE_WAIT_MS + 5_000;

/** What the person's browser answered: the picture as base64 WebP, or that it cannot take one. */
export interface PreviewCaptureAnswer extends FrameSessionProof {
  captureId: string;
  conversationId?: string | undefined;
  image?: string | undefined;
  unavailable?: true | undefined;
}

export class PreviewCaptures {
  private readonly options: ResolvedChatServerOptions;
  private readonly actions: AppActionCalls;
  private readonly conversations: ConversationWorkflow;
  private readonly now: () => Date;

  constructor(
    options: ResolvedChatServerOptions,
    actions: AppActionCalls,
    now: () => Date = () => new Date()
  ) {
    this.options = options;
    this.actions = actions;
    this.conversations = new ConversationWorkflow(options);
    this.now = now;
  }

  /**
   * The caller's own requests of a conversation they read that wait for their browser. A request
   * of a revision that reaches data through a personal connection is refused here, before any
   * picture is taken.
   */
  async pending(
    caller: { user: AuthenticatedUser },
    conversationId: string
  ): Promise<{ captures: { id: string; fileSetId: FileSetId }[] }> {
    const conversation = await this.conversations.requireConversationAccess(
      asConversationId(conversationId),
      caller.user
    );
    const pending = await this.options.stores.pages.pendingPreviewCaptures({
      clientInstanceId: this.options.clientInstanceId,
      conversationId: conversation.id,
      userId: asUserId(getSubjectUserId(caller.user)),
      notBefore: this.windowStart()
    });
    const captures: { id: string; fileSetId: FileSetId }[] = [];
    for (const request of pending) {
      const fileSet = await this.options.stores.pages.getServedFileSet({
        clientInstanceId: this.options.clientInstanceId,
        fileSetId: request.fileSetId
      });
      if (!fileSet || (await this.reachesPersonalData(compiledActionsOf(fileSet.manifest)))) {
        await this.settle(request.id, ["pending"], {
          status: "refused",
          code: fileSet ? "preview_personal_data" : "preview_not_viewed"
        });
        continue;
      }
      captures.push(request);
    }
    return { captures };
  }

  /**
   * Takes the answer of the frame the proof names, for the signed-in caller it was minted for,
   * to the request it names: when the request asks that caller, in the frame's conversation,
   * for the frame's revision, and waits. `accepted: false` says it was no such request.
   */
  async answer(
    caller: { user: AuthenticatedUser; access: ActorAccess },
    input: PreviewCaptureAnswer
  ): Promise<{ accepted: boolean }> {
    const frame = await this.actions.reportingFrame(caller, input);
    const conversationId = await frameConversation(
      this.options,
      this.conversations,
      frame,
      caller.user,
      input.conversationId
    );
    if (conversationId === undefined || !isFileSetId(input.fileSetId)) {
      return { accepted: false };
    }
    const claimed = await this.options.stores.pages.claimPreviewCapture({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      userId: asUserId(getSubjectUserId(caller.user)),
      id: input.captureId,
      fileSetId: input.fileSetId,
      notBefore: this.windowStart()
    });
    if (!claimed) {
      return { accepted: false };
    }
    try {
      if (input.unavailable === true || input.image === undefined) {
        await this.settle(input.captureId, ["answering"], {
          status: "refused",
          code: "capture_unavailable"
        });
        return { accepted: true };
      }
      // What the revision's actions reach, read from its manifest as the request's list did.
      const fileSet = await this.options.stores.pages.getServedFileSet({
        clientInstanceId: this.options.clientInstanceId,
        fileSetId: input.fileSetId
      });
      if (!fileSet || (await this.reachesPersonalData(compiledActionsOf(fileSet.manifest)))) {
        // The picture is dropped as it came: it is neither stored nor read.
        await this.settle(input.captureId, ["answering"], {
          status: "refused",
          code: fileSet ? "preview_personal_data" : "preview_not_viewed"
        });
        return { accepted: true };
      }
      const bytes = new Uint8Array(Buffer.from(input.image, "base64"));
      const size = isPreviewCaptureWithinBounds(bytes);
      const objects = this.options.pages?.objects;
      if (!size || !objects) {
        await this.settle(input.captureId, ["answering"], {
          status: "refused",
          code: "capture_unavailable"
        });
        if (!size) {
          throw new AppError(
            "VALIDATION_FAILED",
            "A picture of a preview is a WebP image of at most 1280 by 1600 pixels and 400 KB",
            undefined,
            { exposeMessage: true }
          );
        }
        return { accepted: true };
      }
      const objectKey = `${previewCaptureObjectPrefix(conversationId)}${input.captureId}.webp`;
      await objects.put(objectKey, bytes, { contentType: "image/webp" });
      const artifact = await this.options.stores.files.createManagedArtifact({
        clientInstanceId: this.options.clientInstanceId,
        conversationId,
        kind: "image.webp",
        objectKey,
        filename: `preview-${input.captureId}.webp`,
        mimeType: "image/webp",
        byteSize: bytes.byteLength,
        checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        metadata: {
          source: PREVIEW_CAPTURE_ARTIFACT_SOURCE,
          // Shown to the model and in the run's work, never in the conversation's files.
          purpose: "inspection",
          fileSetId: input.fileSetId,
          width: size.width,
          height: size.height
        }
      });
      await this.settle(input.captureId, ["answering"], {
        status: "captured",
        artifactId: artifact.id,
        width: size.width,
        height: size.height
      });
      return { accepted: true };
    } catch (error) {
      // A request that could not be answered ends at once: the run does not wait for it.
      await this.settle(input.captureId, ["answering"], {
        status: "refused",
        code: "capture_unavailable"
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Whether an action of the revision reaches outside data through a personal connection
   * (APP-16): a picture of it could show that person's data to everyone who reads the run.
   */
  private async reachesPersonalData(actions: readonly CompiledAppAction[]): Promise<boolean> {
    const names = actions.flatMap((action) =>
      action.kind === "connection"
        ? [connectionOperationName(action.connection, action.operation)]
        : []
    );
    if (names.length === 0) return false;
    const definitions = await this.options.operationCalls.registry.resolveMany(names);
    return [...definitions.values()].some((definition) => definition.personalConnection === true);
  }

  private settle(
    id: string,
    from: readonly ("pending" | "answering")[],
    outcome: Parameters<PagesStore["settlePreviewCapture"]>[0]["outcome"]
  ): Promise<boolean> {
    return this.options.stores.pages.settlePreviewCapture({
      clientInstanceId: this.options.clientInstanceId,
      id,
      from,
      outcome,
      answeredAt: this.now().toISOString()
    });
  }

  private windowStart(): string {
    return new Date(this.now().getTime() - ANSWER_WINDOW_MS).toISOString();
  }
}
