import { useComposer, useComposerRuntime } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { createQueuedSendSettler, type QueuedSend, type SendBlock } from "./send-block";

/**
 * Sends a queued message once its loading block lifts, or forgets it when the user edits the
 * text or the attachments, the block turns into a refusal or the workspace changes. A pane lives for one
 * conversation, so a change of conversation drops the queued send with the pane.
 */
export function QueuedSendBridge({
  queuedSend,
  sendBlock,
  attachmentsKey,
  collaborationWorkspaceId,
  onSettled,
  onSubmitMessage
}: {
  queuedSend: QueuedSend | undefined;
  sendBlock: SendBlock | undefined;
  attachmentsKey: string;
  collaborationWorkspaceId: string | undefined;
  onSettled: () => void;
  /** The first-message path; an open conversation sends through the thread runtime instead. */
  onSubmitMessage: ((text: string) => boolean) | undefined;
}) {
  const composer = useComposerRuntime();
  // A change of the text or of the runtime's readiness asks again.
  const renderedText = useComposer((state) => state.text);
  const renderedCanSend = useComposer((state) => state.canSend);
  const [settle] = useState(createQueuedSendSettler);

  useEffect(() => {
    if (!queuedSend) {
      return;
    }
    // A keystroke or the runtime taking up a block changes the composer before React renders
    // it, and this effect can run before that render. The answer reads the composer as it is
    // now: an edited draft is dropped rather than sent, and a send the runtime would ignore
    // waits rather than being settled.
    const { text, canSend } = composer.getState();
    const step = settle({
      queued: queuedSend,
      block: sendBlock,
      composerText: text,
      attachmentsKey,
      collaborationWorkspaceId,
      runtimeReady: Boolean(onSubmitMessage) || canSend
    });
    if (step === "wait") {
      return;
    }
    onSettled();
    if (step === "drop") {
      return;
    }
    if (onSubmitMessage) {
      onSubmitMessage(queuedSend.text);
    } else {
      composer.send();
    }
  }, [
    attachmentsKey,
    collaborationWorkspaceId,
    composer,
    onSettled,
    onSubmitMessage,
    queuedSend,
    renderedCanSend,
    renderedText,
    sendBlock,
    settle
  ]);

  return null;
}
