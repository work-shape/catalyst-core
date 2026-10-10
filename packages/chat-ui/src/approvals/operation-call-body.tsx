import { EmptyState, KeyValue, KeyValueList } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { operationOriginLabelKeys } from "../operations/operations-model";
import { formatApprovalDate } from "./approval-request-model";
import { useApprovalRevisionHost } from "./approval-revision-host";
import { parseOperationCallPreview } from "./operation-call-preview";

/**
 * An operation call that waits for another person's approval: what runs when it is approved, who
 * called it from where, and the input the call is frozen with. The values are text the server
 * rendered. A preview it cannot read shows a sentence instead of half a call.
 */
export function OperationCallBody({ preview }: { preview: unknown }) {
  const { locale, t } = useTranslation();
  const host = useApprovalRevisionHost();
  const call = parseOperationCallPreview(preview);
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

  return (
    <div className="grid min-w-0 gap-4" data-testid="operation-call" data-run-id={call.runId}>
      <p>{t("operations.callEffect", { actor: call.actor.label })}</p>
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
        {call.expiresAt ? (
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
        {call.inputs.length === 0 ? (
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
                    {t("operations.callTruncated")}
                  </span>
                ) : null}
              </KeyValue>
            ))}
          </KeyValueList>
        )}
      </section>
    </div>
  );
}
