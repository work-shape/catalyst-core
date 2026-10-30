import type { ChatInputCheckView } from "@work-shape/catalyst-api-client";
import { Banner, Button } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { GuardrailAnswers } from "./guardrail-answer";
import { readGuardrailAnswers } from "./guardrail-answer-model";
import { canSendAnyway, useChatInputGuard } from "./chat-input-guard";

/**
 * Above the composer: why the guardrails refused the message in it, with a way to send it anyway
 * where they only warned, or what they could not check of the message just sent (GR-4).
 */
export function ChatInputNotice({
  onSendAnyway
}: {
  /** Sends the composer's message again, its warnings accepted. */
  onSendAnyway(): void;
}) {
  const { t } = useTranslation();
  const guard = useChatInputGuard();
  if (!guard) return null;
  const { refusal, sent, conversationId } = guard;
  if (refusal && refusal.conversationId === conversationId) {
    const answers = readGuardrailAnswers(refusal.details.guardrails);
    const warned = canSendAnyway(refusal);
    const summary = warned
      ? t("chatInput.warned")
      : answers.length > 0
        ? t("chatInput.blocked")
        : t("chatInput.unavailable");
    return (
      <section
        className="grid min-w-0 gap-2"
        aria-label={t("chatInput.label")}
        data-testid="chat-input-refusal"
        data-outcome={warned ? "warn" : "block"}
      >
        <Banner
          tone={warned ? "warning" : "danger"}
          layout="line"
          onDismiss={guard.dismiss}
          action={
            warned ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="chat-input-send-anyway"
                onClick={() => {
                  guard.acceptWarnings();
                  onSendAnyway();
                }}
              >
                {t("chatInput.sendAnyway")}
              </Button>
            ) : undefined
          }
        >
          <span className="wrap-anywhere">{summary}</span>
        </Banner>
        <GuardrailAnswers answers={answers} />
        <NotChecked view={refusal.details} sent={false} />
      </section>
    );
  }
  if (sent && sent.conversationId === conversationId) {
    return (
      <section
        className="grid min-w-0 gap-2"
        aria-label={t("chatInput.label")}
        data-testid="chat-input-sent"
      >
        <NotChecked view={sent.view} sent onDismiss={guard.dismiss} />
      </section>
    );
  }
  return null;
}

/** What the guardrails could not check of a message, each part with its cause. */
function NotChecked({
  view,
  sent,
  onDismiss
}: {
  view: Pick<ChatInputCheckView, "textNotChecked" | "attachmentsNotChecked">;
  sent: boolean;
  onDismiss?(): void;
}) {
  const { t } = useTranslation();
  const files = view.attachmentsNotChecked ?? [];
  if (!view.textNotChecked && files.length === 0) return null;
  return (
    <Banner
      tone="info"
      title={t("chatInput.notCheckedTitle")}
      data-testid="chat-input-not-checked"
      {...(onDismiss ? { onDismiss } : {})}
    >
      <span className="block">
        {t(sent ? "chatInput.notCheckedSent" : "chatInput.notCheckedBefore")}
      </span>
      <ul className="mt-1 grid list-disc gap-0.5 pl-5">
        {view.textNotChecked ? <li>{t("chatInput.textNotChecked")}</li> : null}
        {files.map((file) => (
          <li
            key={file.attachmentId}
            className="wrap-anywhere"
            data-testid="chat-input-not-checked-file"
            data-cause={file.cause}
          >
            {t(`chatInput.cause.${file.cause}`, { name: file.filename })}
          </li>
        ))}
      </ul>
    </Banner>
  );
}
