import { useId, useState } from "react";
import { Check, MessageSquareText } from "lucide-react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { FEEDBACK_TEXT_MAX_LENGTH } from "@work-shape/catalyst-core";
import { Button, Field, InlineError, Textarea } from "@work-shape/catalyst-ui";
import { useResultFeedbackQuery, useSendResultFeedback } from "../../shared/api/feedback";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation } from "../../shared/i18n";

// Feedback on the result of a Workflow run (LU-6), in the notice that tells its reader of the
// run: an action opens a field; once sent, the line says whether a reviewer handled it. One
// comment per person and run; nothing of the run is copied into it.

export function ResultFeedback({ item }: { item: ApprovalRequestView }) {
  const { t } = useTranslation();
  const api = useOptionalWorkspaceApiClient();
  const input = { apiBaseUrl: api?.apiBaseUrl ?? "", client: api?.client, requestId: item.id };
  const own = useResultFeedbackQuery({ ...input, enabled: true });
  const send = useSendResultFeedback({ ...input, heldMessage: t("feedback.waitsForApproval") });
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const fieldId = useId();

  // Until the person's comment has been read nothing offers a second one; a refusal to read
  // it, such as a notice the module no longer serves, offers nothing.
  if (!api || !own.isSuccess) return null;

  if (own.data) {
    const handled = own.data.state === "handled";
    return (
      <p
        className="inline-flex items-center gap-1.5 text-caption text-muted-foreground"
        data-testid="result-feedback-line"
        data-feedback-state={own.data.state}
      >
        {handled ? <Check className="size-3.5" aria-hidden="true" /> : null}
        {t(handled ? "feedback.handled" : "feedback.sent")}
      </p>
    );
  }

  if (!open) {
    return (
      <div>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          data-testid="result-feedback-action"
          onClick={() => setOpen(true)}
        >
          <MessageSquareText aria-hidden="true" />
          {t("feedback.resultAction")}
        </Button>
      </div>
    );
  }

  const trimmed = text.trim();
  const tooLong = trimmed.length > FEEDBACK_TEXT_MAX_LENGTH;
  const submit = () => {
    if (trimmed.length === 0 || tooLong) return;
    setFailed(false);
    send.mutate(trimmed, {
      onSuccess: () => setOpen(false),
      onError: () => setFailed(true)
    });
  };

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="result-feedback-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field
        id={fieldId}
        label={t("feedback.field")}
        hint={t("feedback.resultHint")}
        error={tooLong ? t("feedback.tooLong", { max: FEEDBACK_TEXT_MAX_LENGTH }) : undefined}
      >
        <Textarea
          rows={3}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        />
      </Field>
      {failed ? <InlineError>{t("feedback.sendFailed")}</InlineError> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={send.isPending}
          onClick={() => setOpen(false)}
        >
          {t("cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={send.isPending || trimmed.length === 0 || tooLong}
        >
          {t("feedback.send")}
        </Button>
      </div>
    </form>
  );
}
