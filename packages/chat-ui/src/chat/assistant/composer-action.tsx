import { ComposerPrimitive, useAuiState, useComposerRuntime } from "@assistant-ui/react";
import { Send, Square } from "lucide-react";
import { useCallback } from "react";
import type { FollowUpMode } from "@work-shape/catalyst-api-client";
import { Button, cn } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { composerActions } from "./thread-activity";
import type { SendBlock } from "./send-block";
import { otherShortcutKeys } from "./follow-up-shortcut";

export function ComposerAction({
  sendBlock,
  sendQueued,
  conversationRunning,
  optimisticPending,
  currentText,
  canQueueFollowUp,
  queueingFollowUp,
  followUpMode,
  steersOwnRun,
  onCancelRun,
  onQueueFollowUp,
  onQueueSend,
  onSubmitMessage,
  onSendWithoutText
}: {
  sendBlock: SendBlock | undefined;
  sendQueued: boolean;
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  currentText: string;
  /** A message sent while the run goes waits in the conversation's queue. */
  canQueueFollowUp: boolean;
  queueingFollowUp: boolean;
  /** What the button and Enter do with the reader's message during a run. */
  followUpMode: FollowUpMode;
  /** The run that goes is the reader's: a steer reaches it. */
  steersOwnRun: boolean;
  onCancelRun: () => void;
  onQueueFollowUp: () => void;
  onQueueSend: () => void;
  onSubmitMessage?: (text: string) => boolean;
  /** Set where the draft's attachments may go without text. */
  onSendWithoutText?: () => void;
}) {
  const { t } = useTranslation();
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const emptyText = currentText.trim().length === 0;
  const nothingToSend = emptyText && !onSendWithoutText;
  const actions = composerActions({
    conversationRunning,
    optimisticPending,
    threadRunning,
    canQueue: canQueueFollowUp,
    hasText: !emptyText
  });
  // During a loading block the control stays usable: a click is remembered like an Enter.
  const queuesSend = Boolean(sendBlock?.loading);
  const sendDisabled = queuesSend ? emptyText : Boolean(sendBlock) || nothingToSend;
  const composer = useComposerRuntime();
  // The tooltip names the mode Enter sends in and what the modifier does instead (FU-2). In
  // someone else's run every message waits, so there is nothing else to offer.
  const steers = followUpMode === "steer" && steersOwnRun;
  const followUpTitle = !steersOwnRun
    ? t(followUpMode === "steer" ? "followUpSteerNotOwn" : "followUpSend")
    : t(steers ? "followUpSteerTitle" : "followUpSendTitle", { keys: otherShortcutKeys() });
  const handleSendClick = useCallback(() => {
    if (onSubmitMessage) onSubmitMessage(composer.getState().text);
    else onSendWithoutText?.();
  }, [composer, onSendWithoutText, onSubmitMessage]);
  const stopButton = (placement: "alone" | "beside") => {
    const button = (
      <Button
        type="button"
        size="icon"
        variant={placement === "alone" ? "solid" : "secondary"}
        className={cn("size-9", placement === "alone" && "absolute inset-0")}
        aria-label={t("stopGenerating")}
        title={t("stopGenerating")}
        onClick={onCancelRun}
      >
        <Square size={14} className="fill-current" aria-hidden="true" />
      </Button>
    );
    return threadRunning ? (
      <ComposerPrimitive.Cancel asChild>{button}</ComposerPrimitive.Cancel>
    ) : (
      button
    );
  };

  if (actions === "stop-and-send") {
    return (
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {stopButton("beside")}
        <Button
          type="button"
          size="icon"
          variant="solid"
          className="size-9"
          aria-label={t(steers ? "followUpSteer" : "followUpSend")}
          title={sendBlock?.reason ?? followUpTitle}
          disabled={Boolean(sendBlock)}
          loading={queueingFollowUp}
          onClick={onQueueFollowUp}
        >
          <Send size={17} aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative ml-auto size-9">
      {actions === "stop" ? (
        stopButton("alone")
      ) : queuesSend ? (
        <Button
          type="button"
          size="icon"
          variant="solid"
          className="absolute inset-0 size-9"
          aria-label={t("sendMessage")}
          title={sendBlock?.reason}
          disabled={sendDisabled}
          loading={sendQueued}
          onClick={onQueueSend}
        >
          <Send size={17} aria-hidden="true" />
        </Button>
      ) : onSubmitMessage || (emptyText && onSendWithoutText) ? (
        <Button
          type="button"
          size="icon"
          variant="solid"
          className="absolute inset-0 size-9"
          aria-label={t("sendMessage")}
          title={sendBlock?.reason ?? t("sendMessage")}
          disabled={sendDisabled}
          onClick={handleSendClick}
        >
          <Send size={17} aria-hidden="true" />
        </Button>
      ) : (
        <ComposerPrimitive.Send asChild>
          <Button
            type="button"
            size="icon"
            variant="solid"
            className="absolute inset-0 size-9"
            aria-label={t("sendMessage")}
            title={sendBlock?.reason ?? t("sendMessage")}
            disabled={sendDisabled}
          >
            <Send size={17} aria-hidden="true" />
          </Button>
        </ComposerPrimitive.Send>
      )}
    </div>
  );
}
