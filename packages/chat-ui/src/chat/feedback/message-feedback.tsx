import { useId, useState } from "react";
import { Check, MessageSquareText } from "lucide-react";
import { ApiError, type OwnFeedback, type SafeConfig } from "@work-shape/catalyst-api-client";
import { FEEDBACK_TEXT_MAX_LENGTH } from "@work-shape/catalyst-core";
import { Button, Checkbox, Field, InlineError, Textarea } from "@work-shape/catalyst-ui";
import { useOwnFeedbackMutations, useOwnFeedbackQuery } from "../../shared/api/feedback";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation, type TranslationKey } from "../../shared/i18n";

// Feedback under an agent's answer (LU-4): a "Feedback" action beside copy opens a field and a
// box for the exchange; once sent, the line under the answer says its state, and its author
// changes or withdraws it until a reviewer marked it handled. No thumbs, no rating.

/** What the thread knows of feedback where the module is on. Absent, nothing is shown. */
export interface MessageFeedbackSetup {
  conversationId: string;
  /** The instance lets a comment carry a copy of the question and the answer. */
  exchangeSnapshot: boolean;
}

/** Feedback under the answers, where the module is on and a conversation is open. */
export function messageFeedbackSetup(
  config: SafeConfig | undefined,
  conversationId: string | undefined
): MessageFeedbackSetup | undefined {
  if (!conversationId || config?.modules.feedback?.enabled !== true) return undefined;
  return { conversationId, exchangeSnapshot: config.feedback?.exchangeSnapshot ?? true };
}

type Editing = { mode: "new" } | { mode: "edit"; feedback: OwnFeedback };

export interface MessageFeedbackState {
  setup: MessageFeedbackSetup;
  runId: string;
  editing: Editing | undefined;
  setEditing(editing: Editing | undefined): void;
}

/**
 * The feedback of one answer, where the module is on and the answer is a finished run's. It
 * reads nothing itself: the action and the panel read the person's comments, one query per
 * conversation for every answer of it.
 */
export function useMessageFeedback(
  setup: MessageFeedbackSetup | undefined,
  runId: string | undefined
): MessageFeedbackState | undefined {
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  if (!setup || !runId) return undefined;
  return { setup, runId, editing, setEditing };
}

/** The person's comment on the answer, once the list of the conversation has arrived. */
function useOwnFeedback(state: MessageFeedbackState) {
  const api = useOptionalWorkspaceApiClient();
  const query = useOwnFeedbackQuery({
    apiBaseUrl: api?.apiBaseUrl ?? "",
    client: api?.client,
    conversationId: state.setup.conversationId,
    enabled: true
  });
  return { own: query.data?.get(state.runId), loaded: query.isSuccess };
}

/** The action beside copy. It is offered while the person has left no comment on the answer. */
export function MessageFeedbackAction({ state }: { state: MessageFeedbackState }) {
  const { t } = useTranslation();
  const { own, loaded } = useOwnFeedback(state);
  // Until the list has arrived nothing offers a second comment.
  if (!loaded || own || state.editing) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-muted-foreground"
      data-testid="message-feedback-action"
      onClick={() => state.setEditing({ mode: "new" })}
    >
      <MessageSquareText aria-hidden="true" />
      {t("feedback.action")}
    </Button>
  );
}

/** Under the answer: the open field, or the state of the person's comment. */
export function MessageFeedbackPanel({ state }: { state: MessageFeedbackState }) {
  const { own } = useOwnFeedback(state);
  if (state.editing) return <FeedbackForm state={state} editing={state.editing} />;
  if (own) return <FeedbackLine state={state} own={own} />;
  return null;
}

function FeedbackLine({ state, own }: { state: MessageFeedbackState; own: OwnFeedback }) {
  const { t } = useTranslation();
  const mutations = useMutationsOf(state);
  const [failure, setFailure] = useState<TranslationKey | undefined>(undefined);
  const handled = own.state === "handled";
  return (
    <div className="grid max-w-3xl gap-2 px-1" data-testid="message-feedback-line">
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <span className="inline-flex items-center gap-1.5" data-feedback-state={own.state}>
          {handled ? <Check className="size-3.5" aria-hidden="true" /> : null}
          {t(handled ? "feedback.handled" : "feedback.sent")}
        </span>
        {handled || !mutations ? null : (
          <>
            <Button
              size="sm"
              variant="link"
              className="px-0"
              disabled={mutations.withdraw.isPending}
              onClick={() => state.setEditing({ mode: "edit", feedback: own })}
            >
              {t("feedback.edit")}
            </Button>
            <Button
              size="sm"
              variant="link"
              className="px-0"
              disabled={mutations.withdraw.isPending}
              onClick={() => {
                setFailure(undefined);
                mutations.withdraw.mutate(own.id, {
                  onError: (error) => setFailure(failureOf(error, "withdraw"))
                });
              }}
            >
              {t("feedback.withdraw")}
            </Button>
          </>
        )}
      </div>
      {failure ? <InlineError>{t(failure)}</InlineError> : null}
    </div>
  );
}

function FeedbackForm({ state, editing }: { state: MessageFeedbackState; editing: Editing }) {
  const { t } = useTranslation();
  const fieldId = useId();
  const mutations = useMutationsOf(state);
  const existing = editing.mode === "edit" ? editing.feedback : undefined;
  const [text, setText] = useState(existing?.text ?? "");
  // Ticked when the field opens (P32); a comment that left the exchange out keeps it out.
  const [includeExchange, setIncludeExchange] = useState(existing?.includesExchange ?? true);
  const [failure, setFailure] = useState<TranslationKey | undefined>(undefined);
  const trimmed = text.trim();
  const tooLong = trimmed.length > FEEDBACK_TEXT_MAX_LENGTH;
  const pending = Boolean(mutations?.send.isPending || mutations?.update.isPending);
  const include = state.setup.exchangeSnapshot && includeExchange;

  const submit = () => {
    if (!mutations || trimmed.length === 0 || tooLong) return;
    setFailure(undefined);
    const done = { onSuccess: () => state.setEditing(undefined) };
    if (existing) {
      mutations.update.mutate(
        { feedbackId: existing.id, text: trimmed, includeExchange: include },
        { ...done, onError: (error) => setFailure(failureOf(error, "save")) }
      );
    } else {
      mutations.send.mutate(
        { runId: state.runId, text: trimmed, includeExchange: include },
        { ...done, onError: (error) => setFailure(failureOf(error, "send")) }
      );
    }
  };

  return (
    <form
      className="grid max-w-3xl gap-3 rounded-lg border border-border bg-card p-3"
      data-testid="message-feedback-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field
        id={fieldId}
        label={t("feedback.field")}
        hint={t("feedback.hint")}
        error={tooLong ? t("feedback.tooLong", { max: FEEDBACK_TEXT_MAX_LENGTH }) : undefined}
      >
        <Textarea
          rows={3}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") state.setEditing(undefined);
          }}
        />
      </Field>
      {state.setup.exchangeSnapshot ? (
        <Checkbox
          checked={includeExchange}
          onCheckedChange={setIncludeExchange}
          label={t("feedback.includeExchange")}
        />
      ) : null}
      {failure ? <InlineError>{t(failure)}</InlineError> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => state.setEditing(undefined)}
        >
          {t("cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={pending || trimmed.length === 0 || tooLong}
        >
          {t(existing ? "feedback.save" : "feedback.send")}
        </Button>
      </div>
    </form>
  );
}

function useMutationsOf(state: MessageFeedbackState) {
  const { t } = useTranslation();
  const api = useOptionalWorkspaceApiClient();
  const mutations = useOwnFeedbackMutations({
    apiBaseUrl: api?.apiBaseUrl ?? "",
    client: api?.client,
    conversationId: state.setup.conversationId,
    heldMessage: t("feedback.waitsForApproval")
  });
  return api ? mutations : undefined;
}

/** What a failed change says: a handled comment stays as it is, anything else failed. */
function failureOf(error: unknown, action: "send" | "save" | "withdraw"): TranslationKey {
  if (action !== "send" && error instanceof ApiError && error.code === "CONFLICT") {
    return "feedback.alreadyHandled";
  }
  return action === "send"
    ? "feedback.sendFailed"
    : action === "save"
      ? "feedback.saveFailed"
      : "feedback.withdrawFailed";
}
