import type { ConversationSnapshotStatus } from "../conversation/conversation-controller-state";
import type { TranslationContextValue } from "../i18n";

/** Why the composer may not send right now. */
export interface SendBlock {
  reason: string;
  /**
   * True while the app is still loading what a send needs. Such a block lifts by itself, so a
   * send asked for meanwhile waits for it. Every other block is a refusal and drops the send.
   */
  loading: boolean;
}

/** The one block that applies to the composer, in the order the user should hear about them. */
export function resolveSendBlock(input: {
  /** A first message of this pane is on its way to the server. */
  sending: boolean;
  conversationRunning: boolean;
  workspaceBlock: SendBlock | undefined;
  snapshotStatus: ConversationSnapshotStatus;
  noAgentsMessage: string | undefined;
  t: TranslationContextValue["t"];
}): SendBlock | undefined {
  if (input.sending) {
    // Not a loading block: the message is already sent, so waiting would send it again.
    return { reason: input.t("loadingConversation"), loading: false };
  }
  if (input.conversationRunning) {
    return { reason: input.t("conversationStillRunning"), loading: false };
  }
  if (input.workspaceBlock) {
    return input.workspaceBlock;
  }
  if (input.snapshotStatus === "loading") {
    return { reason: input.t("loadingConversation"), loading: true };
  }
  if (input.snapshotStatus !== "ready") {
    // A failed load does not lift by itself; a later refetch must not send what waited.
    return { reason: input.t("conversationLoadFailed"), loading: false };
  }
  return input.noAgentsMessage === undefined
    ? undefined
    : { reason: input.noAgentsMessage, loading: false };
}

/**
 * A send waits only for what passes by itself: a loading block, or the thread runtime taking up
 * a block that has just lifted. It needs text and is remembered once.
 */
export function shouldQueueSend(input: {
  sendBlock: SendBlock | undefined;
  sendQueued: boolean;
  text: string;
  /** False while an open conversation's thread runtime would still ignore a send. */
  runtimeReady: boolean;
}): boolean {
  const passes = input.sendBlock ? input.sendBlock.loading : !input.runtimeReady;
  return passes && !input.sendQueued && input.text.trim().length > 0;
}

/** A send the user asked for while a loading block held it back. */
export interface QueuedSend {
  text: string;
  /** The workspace the message was written for; undefined while the first one still loads. */
  collaborationWorkspaceId: string | undefined;
  /** The draft's attachments when the send was asked for, as `draftAttachmentsKey` names them. */
  attachmentsKey: string;
}

/** Names the draft's attachments, so that adding or removing one reads as an edit. */
export function draftAttachmentsKey(attachments: readonly { id: string }[]): string {
  return attachments.map((attachment) => attachment.id).join("\n");
}

export type QueuedSendStep = "wait" | "send" | "drop";

export interface QueuedSendState {
  queued: QueuedSend;
  block: SendBlock | undefined;
  composerText: string;
  attachmentsKey: string;
  collaborationWorkspaceId: string | undefined;
  /** False while the thread runtime has not taken up the lifted block yet. */
  runtimeReady: boolean;
}

/**
 * What happens to a queued send now. It goes out only as the draft the user confirmed, text and
 * attachments unchanged, into the workspace it was written for, and only when the block lifted without turning into a refusal.
 */
function queuedSendStep(input: QueuedSendState): QueuedSendStep {
  const { queued, block } = input;
  if (input.composerText !== queued.text || input.attachmentsKey !== queued.attachmentsKey) {
    return "drop";
  }
  if (
    queued.collaborationWorkspaceId !== undefined &&
    queued.collaborationWorkspaceId !== input.collaborationWorkspaceId
  ) {
    return "drop";
  }
  if (block) {
    return block.loading ? "wait" : "drop";
  }
  return input.runtimeReady ? "send" : "wait";
}

/**
 * Decides each queued send once. After it answered "send" or "drop" for a queued send, every
 * later question about the same one answers "wait", so a repeated effect cannot send twice.
 */
export function createQueuedSendSettler(): (state: QueuedSendState) => QueuedSendStep {
  let settled: QueuedSend | undefined;
  return (state) => {
    if (state.queued === settled) {
      return "wait";
    }
    const step = queuedSendStep(state);
    if (step !== "wait") {
      settled = state.queued;
    }
    return step;
  };
}
