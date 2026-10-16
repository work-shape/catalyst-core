import { useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  Card,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Field,
  KeyValue,
  KeyValueList,
  Spinner,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { ApprovalRequestCard } from "./approval-request-card";
import { formatApprovalDate } from "./approval-request-model";
import { CallInputs } from "./operation-call-body";
import {
  useToolDecisionDecide,
  useWaitingOperationRunQuery,
  type ToolDecisionInput
} from "./tool-decision-api";
import {
  DECLINE_REASON_MAX_CHARS,
  toolDecisionInputRows,
  type ToolDecision,
  type ToolDecisionFailure,
  type ToolDecisionOutcome
} from "./tool-decision-model";

const OUTCOME: Record<ToolDecisionOutcome, { label: TranslationKey; tone: "info" | "success" }> = {
  confirmed: { label: "toolDecisionAllowed", tone: "success" },
  declined: { label: "toolDecisionDenied", tone: "info" }
};

const FAILURE: Record<ToolDecisionFailure, TranslationKey> = {
  failed: "toolDecisionFailed",
  already_decided: "toolDecisionAlreadyDecided",
  expired: "toolDecisionExpired",
  not_yours: "toolDecisionNotYours"
};

/**
 * The host's own card on an agent's call that waits for a decision. A confirmation asks the
 * person the run acts for to allow or deny the call as it will run; an approval shows the
 * request that somebody else decides.
 */
export function ToolDecisionCard({
  decision,
  title,
  toolName
}: {
  decision: ToolDecision;
  /** The call's label, as the tool call's own line names it. */
  title: string;
  toolName: string;
}) {
  return decision.mode === "approval" ? (
    <ToolApprovalWait decision={decision} />
  ) : (
    <ToolConfirmation decision={decision} title={title} toolName={toolName} />
  );
}

function ToolConfirmation({
  decision,
  title,
  toolName
}: {
  decision: ToolDecision;
  title: string;
  toolName: string;
}) {
  const answer = useToolDecisionDecide(decision.operationRunId);
  return (
    <ToolDecisionCardView decision={decision} title={title} toolName={toolName} answer={answer} />
  );
}

export interface ToolDecisionAnswer {
  decide(decision: ToolDecisionInput): void;
  pending: boolean;
  /** The answer the server took, until the run's record of it arrives. */
  decided: ToolDecisionInput | undefined;
  failure: ToolDecisionFailure | undefined;
}

/** The confirmation as drawn: the call, its input, the expiry, and Allow and Deny. */
export function ToolDecisionCardView({
  decision,
  title,
  toolName,
  answer
}: {
  decision: ToolDecision;
  title: string;
  toolName: string;
  answer: ToolDecisionAnswer;
}) {
  const { locale, t } = useTranslation();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  // The answer shows until the run records it, which takes the card away in every tab.
  const outcome = takenOutcome(answer.decided);
  const outcomeReason = answer.decided?.reason;
  const rows = toolDecisionInputRows(decision.inputPreview);

  function deny(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const trimmed = reason.trim();
    answer.decide({ decision: "decline", ...(trimmed ? { reason: trimmed } : {}) });
  }

  return (
    <Card
      className="grid min-w-0 gap-3 px-4 py-3 text-body"
      role="group"
      aria-label={t("toolDecisionLabel", { title })}
      data-testid="tool-decision-card"
      data-mode="confirm"
      data-outcome={outcome}
    >
      <div className="grid min-w-0 gap-0.5">
        <p className="font-medium text-foreground wrap-anywhere">{title}</p>
        {outcome ? null : (
          <p className="text-caption text-muted-foreground">{t("toolDecisionWaiting")}</p>
        )}
      </div>
      {outcome ? (
        <Banner
          layout="line"
          tone={OUTCOME[outcome].tone}
          data-testid="tool-decision-outcome"
          data-outcome={outcome}
        >
          {t(OUTCOME[outcome].label)}
          {outcome === "declined" && outcomeReason ? (
            <span className="block text-caption text-muted-foreground wrap-anywhere">
              {t("operations.callOutcomeReason", { reason: outcomeReason })}
            </span>
          ) : null}
        </Banner>
      ) : null}
      <CallInputs
        call={{ inputs: rows, inputFieldCount: rows.length, inputRemoved: false }}
        hiddenFields={0}
      />
      <Disclosure data-testid="tool-decision-details">
        <DisclosureTrigger>{t("operations.callDetails")}</DisclosureTrigger>
        <DisclosureContent>
          <KeyValueList className="pt-1">
            <KeyValue label={t("operations.operation")} data-field="operation">
              <span className="font-mono text-code wrap-anywhere">{decision.operationId}</span>
            </KeyValue>
            <KeyValue label={t("operations.fieldToolName")} data-field="tool">
              <span className="font-mono text-code wrap-anywhere">{toolName}</span>
            </KeyValue>
          </KeyValueList>
        </DisclosureContent>
      </Disclosure>
      {outcome ? null : (
        <form className="grid min-w-0 gap-2" onSubmit={deny}>
          {reasonOpen ? (
            <Field label={t("toolDecisionReason")} hint={t("toolDecisionReasonHint")} optional>
              <Textarea
                autoFocus
                rows={2}
                maxLength={DECLINE_REASON_MAX_CHARS}
                value={reason}
                disabled={answer.pending}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={answer.pending}
              onClick={() => answer.decide({ decision: "confirm" })}
            >
              {t("toolDecisionAllow")}
            </Button>
            <Button type="submit" size="sm" variant="outline" disabled={answer.pending}>
              {t("toolDecisionDeny")}
            </Button>
            {reasonOpen ? null : (
              <Button
                type="button"
                size="sm"
                variant="link"
                disabled={answer.pending}
                onClick={() => setReasonOpen(true)}
              >
                {t("toolDecisionAddReason")}
              </Button>
            )}
            {answer.pending ? <Spinner size="sm" /> : null}
            <span
              className="ml-auto text-caption text-muted-foreground"
              data-testid="tool-decision-expires"
            >
              {t("toolDecisionExpires", { date: formatApprovalDate(decision.expiresAt, locale) })}
            </span>
          </div>
          {answer.failure ? (
            <p role="alert" className="text-caption text-destructive">
              {t(FAILURE[answer.failure])}
            </p>
          ) : null}
        </form>
      )}
    </Card>
  );
}

function takenOutcome(decided: ToolDecisionInput | undefined): ToolDecisionOutcome | undefined {
  if (!decided) return undefined;
  return decided.decision === "confirm" ? "confirmed" : "declined";
}

/**
 * A call that waits for somebody else's approval: the request's own card, under one line that
 * says the agent waits for it.
 */
function ToolApprovalWait({ decision }: { decision: ToolDecision }) {
  const { t } = useTranslation();
  const run = useWaitingOperationRunQuery(decision.operationRunId);
  const requestId = run.data?.approvalRequestId;
  return (
    <div className="grid min-w-0 gap-2" data-testid="tool-decision-card" data-mode="approval">
      <p className="text-caption text-muted-foreground">{t("toolDecisionAwaitingApproval")}</p>
      {requestId ? <ApprovalRequestCard requestId={requestId} /> : null}
    </div>
  );
}
