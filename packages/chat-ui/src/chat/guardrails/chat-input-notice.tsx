import { Banner, Button } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { GuardrailAnswers } from "./guardrail-answer";
import { readGuardrailAnswers } from "./guardrail-answer-model";
import { canSendAnyway, useChatInputGuard } from "./chat-input-guard";

/**
 * Above the composer: why the guardrails refused the message in it, with a way to send it anyway
 * where they only warned (GR-4). What they could not check of a message is not said here: it
 * stands in the guardrail results admins read.
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
  const { refusal, conversationId } = guard;
  if (!refusal || refusal.conversationId !== conversationId) return null;
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
    </section>
  );
}
