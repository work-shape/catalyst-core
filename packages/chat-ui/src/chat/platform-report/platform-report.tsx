import { useId, useState } from "react";
import { Check, Flag } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, completedOutput } from "@work-shape/catalyst-api-client";
import { PLATFORM_REPORT_NOTE_MAX_LENGTH } from "@work-shape/catalyst-core";
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  InlineError,
  KeyValue,
  KeyValueList,
  Textarea
} from "@work-shape/catalyst-ui";
import {
  useOptionalWorkspaceApiClient,
  type WorkspaceApiClientContextValue
} from "../../shared/api/workspace-api-client";
import { useWorkspaceMeQuery } from "../../shared/api/workspace-queries";
import { apiErrorReason } from "../../shared/workspace-utils";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type { PlatformFailure, PlatformReportSetup } from "./platform-report-model";

export {
  platformFailureOfRunError,
  platformReportSetup,
  type PlatformFailure,
  type PlatformReportSetup
} from "./platform-report-model";

// "Problem an Workshape melden" (PLATFORM-REPORT). A run or a tool that failed for a platform
// reason offers it; the dialog says what goes to Workshape and what does not, takes an
// optional note and sends. The server decides again from its own records.

function failureText(error: unknown): TranslationKey {
  if (error instanceof ApiError) {
    if (error.code === "RATE_LIMITED") return "platformReport.rateLimited";
    if (error.code === "CONFLICT" && apiErrorReason(error) === "already_reported") {
      return "platformReport.alreadyReported";
    }
  }
  return "platformReport.failed";
}

/**
 * The action, a quiet button, and its dialog. Once sent it says so in place; a report sent
 * before, in another tab or before a reload, answers "already reported".
 */
export function PlatformReportAction({
  setup,
  runId,
  failure,
  variant = "ghost"
}: {
  setup: PlatformReportSetup;
  runId: string;
  failure: PlatformFailure;
  variant?: "ghost" | "outline";
}) {
  const { t } = useTranslation();
  const api = useOptionalWorkspaceApiClient();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  // Outside a workspace's client nothing is sent, so nothing is offered.
  if (!api) return null;
  if (sent) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2 text-caption text-muted-foreground"
        data-testid="platform-report-sent"
      >
        <Check className="size-3.5" aria-hidden="true" />
        {t("platformReport.sent")}
      </span>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        className={variant === "ghost" ? "text-muted-foreground" : undefined}
        data-testid="platform-report-action"
        onClick={() => setOpen(true)}
      >
        <Flag aria-hidden="true" />
        {t("platformReport.action")}
      </Button>
      {open ? (
        <PlatformReportDialog
          api={api}
          setup={setup}
          runId={runId}
          failure={failure}
          onClose={() => setOpen(false)}
          onSent={() => {
            setOpen(false);
            setSent(true);
          }}
        />
      ) : null}
    </>
  );
}

function PlatformReportDialog({
  api,
  setup,
  runId,
  failure,
  onClose,
  onSent
}: {
  api: WorkspaceApiClientContextValue;
  setup: PlatformReportSetup;
  runId: string;
  failure: PlatformFailure;
  onClose(): void;
  onSent(): void;
}) {
  const { t, locale } = useTranslation();
  const noteId = useId();
  const me = useWorkspaceMeQuery({ apiBaseUrl: api.apiBaseUrl, client: api.client });
  const email = me.data?.email;
  const [note, setNote] = useState("");
  const [replyToMe, setReplyToMe] = useState(false);
  const send = useMutation({
    mutationFn: async () => {
      const trimmed = note.trim();
      return completedOutput(
        await api.client.platform_report.send({
          params: { conversationId: setup.conversationId, runId },
          body: { ...(trimmed ? { note: trimmed } : {}), replyToMe: replyToMe && !!email }
        })
      );
    },
    onSuccess: onSent
  });
  const tooLong = note.trim().length > PLATFORM_REPORT_NOTE_MAX_LENGTH;
  const time = failure.at
    ? new Date(failure.at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
    : t("platformReport.timeNow");
  const formId = `${noteId}-form`;
  return (
    <Dialog
      open
      size="sm"
      title={t("platformReport.title")}
      description={t("platformReport.description")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={send.isPending} onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={send.isPending || tooLong}
            data-testid="platform-report-send"
          >
            {t("platformReport.send")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-4"
        data-testid="platform-report-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!tooLong) send.mutate();
        }}
      >
        <section className="grid gap-2">
          <h3 className="text-caption font-medium text-foreground">
            {t("platformReport.whatIsSent")}
          </h3>
          <KeyValueList>
            <KeyValue label={t("platformReport.run")}>
              <span className="font-mono text-caption">{runId}</span>
            </KeyValue>
            <KeyValue label={t("platformReport.errorCode")}>
              <span className="font-mono text-caption">{failure.errorCode}</span>
            </KeyValue>
            <KeyValue label={t("platformReport.instance")}>{setup.instanceName}</KeyValue>
            <KeyValue label={t("platformReport.time")}>{time}</KeyValue>
          </KeyValueList>
          <p className="text-caption text-muted-foreground">{t("platformReport.alsoSent")}</p>
          <p className="text-caption text-muted-foreground">{t("platformReport.notSent")}</p>
        </section>
        <Field
          id={noteId}
          label={t("platformReport.noteLabel")}
          hint={t("platformReport.noteHint")}
          error={
            tooLong
              ? t("platformReport.noteTooLong", { max: PLATFORM_REPORT_NOTE_MAX_LENGTH })
              : undefined
          }
        >
          <Textarea
            rows={3}
            value={note}
            data-testid="platform-report-note"
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {email ? (
          <Checkbox
            checked={replyToMe}
            onCheckedChange={setReplyToMe}
            label={t("platformReport.replyToMe")}
            description={t("platformReport.replyToMeHint", { email })}
          />
        ) : null}
        {send.isError ? <InlineError>{t(failureText(send.error))}</InlineError> : null}
      </form>
    </Dialog>
  );
}
