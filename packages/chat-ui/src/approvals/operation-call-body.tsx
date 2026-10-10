import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import { Banner, Button, Dialog, EmptyState, KeyValue, KeyValueList } from "@vivd-catalyst/ui";
import { useState } from "react";
import { useTranslation, type TranslationKey } from "../i18n";
import { operationOriginLabelKeys } from "../operations/operations-model";
import { formatApprovalDate } from "./approval-request-model";
import { useApprovalRevisionHost } from "./approval-revision-host";
import {
  operationCallFullInput,
  operationCallOutcome,
  parseOperationCallPreview,
  type OperationCallOutcome
} from "./operation-call-preview";

const OUTCOME: Record<
  OperationCallOutcome,
  { label: TranslationKey; tone: "info" | "success" | "danger" | "warning" }
> = {
  queued: { label: "operations.callOutcomeQueued", tone: "info" },
  done: { label: "operations.callOutcomeDone", tone: "success" },
  failed: { label: "operations.callOutcomeFailed", tone: "danger" },
  interrupted: { label: "operations.callOutcomeInterrupted", tone: "danger" },
  refused: { label: "operations.callOutcomeRefused", tone: "warning" },
  expired: { label: "operations.callOutcomeExpired", tone: "warning" }
};

/**
 * An operation call that waits for another person's approval: what runs when it is approved, who
 * called it from where, and the input the call is frozen with. The rows are text the server
 * rendered; what a row or the list leaves out is counted in words, and the full view shows the
 * whole input the request keeps. Once the request is decided, the item says what became of the
 * call. A preview it cannot read shows a sentence instead of half a call.
 */
export function OperationCallBody({
  request
}: {
  request: Pick<ApprovalRequestView, "preview" | "status" | "applyResult" | "payload">;
}) {
  const { locale, t } = useTranslation();
  const host = useApprovalRevisionHost();
  const [fullInputOpen, setFullInputOpen] = useState(false);
  const call = parseOperationCallPreview(request.preview);
  if (!call) {
    return (
      <EmptyState layout="inline" data-testid="operation-call-unreadable">
        {t("operations.callUnreadable")}
      </EmptyState>
    );
  }
  const { agentName, toolName } = call.origin;
  const origin = [
    t(operationOriginLabelKeys[call.origin.kind]),
    agentName
      ? t("operations.throughAgent", { agent: host?.agentDisplayName(agentName) ?? agentName })
      : undefined
  ]
    .filter(Boolean)
    .join(", ");

  const pending = request.status === "pending";
  const outcome = pending ? undefined : operationCallOutcome(request);
  const fullInput = operationCallFullInput(request.payload);
  const hiddenFields = call.inputFieldCount - call.inputs.length;

  return (
    <div className="grid min-w-0 gap-4" data-testid="operation-call" data-run-id={call.runId}>
      {pending ? <p>{t("operations.callEffect", { actor: call.actor.label })}</p> : null}
      {outcome ? (
        <Banner
          tone={OUTCOME[outcome.outcome].tone}
          data-testid="operation-call-outcome"
          data-outcome={outcome.outcome}
        >
          {t(OUTCOME[outcome.outcome].label)}
          {outcome.reason ? (
            <span className="block text-caption">
              {t("operations.callOutcomeReason", { reason: outcome.reason })}
            </span>
          ) : null}
        </Banner>
      ) : null}
      <KeyValueList>
        <KeyValue label={t("operations.operation")} data-field="operation">
          <span className="font-mono text-code wrap-anywhere">{call.operation}</span>
        </KeyValue>
        <KeyValue label={t("operations.callCalledBy")} data-field="actor">
          {call.actor.label}
        </KeyValue>
        <KeyValue label={t("operations.origin")} data-field="origin">
          {origin}
        </KeyValue>
        {toolName ? (
          <KeyValue label={t("operations.fieldToolName")} data-field="tool">
            <span className="font-mono text-code wrap-anywhere">{toolName}</span>
          </KeyValue>
        ) : null}
        {call.expiresAt && pending ? (
          <KeyValue label={t("operations.callExpires")} data-field="expiresAt">
            {formatApprovalDate(call.expiresAt, locale)}
            <span className="block text-caption text-muted-foreground">
              {t("operations.callExpiresHint")}
            </span>
          </KeyValue>
        ) : null}
      </KeyValueList>
      <section className="grid min-w-0 gap-2" data-testid="operation-call-inputs">
        <h4 className="text-label">{t("operations.callInputs")}</h4>
        {call.inputRemoved ? (
          <p className="text-muted-foreground" data-testid="operation-call-input-removed">
            {t("operations.callInputRemoved")}
          </p>
        ) : call.inputs.length === 0 ? (
          <p className="text-muted-foreground">{t("operations.callNoInputs")}</p>
        ) : (
          <KeyValueList layout="stacked" className="rounded-md border p-3">
            {call.inputs.map((input) => (
              <KeyValue
                key={input.key}
                label={<span className="font-mono">{input.key}</span>}
                foldable
                data-input-key={input.key}
                data-truncated={input.truncated || undefined}
              >
                <span className="font-mono text-code wrap-anywhere whitespace-pre-wrap">
                  {input.value}
                </span>
                {input.truncated ? (
                  <span className="block text-caption text-muted-foreground">
                    {input.length === undefined
                      ? t("operations.callTruncated")
                      : t("operations.callTruncatedOf", {
                          shown: input.value.length,
                          total: input.length
                        })}
                  </span>
                ) : null}
              </KeyValue>
            ))}
          </KeyValueList>
        )}
        {hiddenFields > 0 ? (
          <p data-testid="operation-call-hidden-fields">
            {t("operations.callHiddenFields", {
              total: call.inputFieldCount,
              shown: call.inputs.length
            })}
          </p>
        ) : null}
        {fullInput !== undefined && call.inputFieldCount > 0 ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              data-testid="operation-call-full-input-open"
              onClick={() => setFullInputOpen(true)}
            >
              {t("operations.callFullInputOpen")}
            </Button>
          </div>
        ) : null}
      </section>
      {fullInput !== undefined ? (
        <Dialog
          open={fullInputOpen}
          size="lg"
          title={t("operations.callFullInputTitle")}
          description={t("operations.callFullInputDescription", { operation: call.operation })}
          onClose={() => setFullInputOpen(false)}
        >
          <pre
            className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-code wrap-anywhere"
            data-testid="operation-call-full-input"
          >
            {fullInput}
          </pre>
        </Dialog>
      ) : null}
    </div>
  );
}
