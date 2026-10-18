import { Banner } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { useApprovalRevisionHost } from "./approval-revision-host";
import type { OperationCallPreview } from "./operation-call-preview";
import { publishKindPhrase } from "./publish-review";

/** Who asks and what for, by where the call came from: an agent, a publish, another call. */
type Asker = "agent" | "publish" | "call";

const WAITS: Record<Asker, TranslationKey> = {
  agent: "operations.confirmWaitsRun",
  publish: "operations.confirmWaitsPublish",
  call: "operations.confirmWaitsCall"
};

const EFFECT: Record<Asker, TranslationKey> = {
  agent: "operations.confirmEffectAgent",
  publish: "operations.confirmPublishEffect",
  call: "operations.confirmEffectCall"
};

/**
 * The lead of a confirmation that waits in its person's Inbox (OP-4b): who asks for what on
 * their behalf, that it waits for them, what Allow and Deny do, and that nobody else can decide
 * it. An agent's call names the agent; `catalyst <kind> publish --yes` names the publish. A
 * call that says in one question what it changes, as a row write of a Data Store does, asks it
 * under the headline.
 */
export function ConfirmationLead({
  call,
  summary
}: {
  call: OperationCallPreview;
  summary?: string;
}) {
  const { t } = useTranslation();
  const host = useApprovalRevisionHost();
  const asker: Asker = call.review ? "publish" : call.origin.kind === "agent" ? "agent" : "call";
  const agentName = call.origin.agentName;
  const agent = agentName ? (host?.agentDisplayName(agentName) ?? agentName) : call.actor.label;
  const changing = call.effect === "changing";

  return (
    <div className="grid min-w-0 gap-1.5" data-testid="confirmation-lead" data-asker={asker}>
      <p className="font-medium text-foreground" data-testid="operation-call-headline">
        {call.review
          ? t("operations.confirmPublishHeadline", {
              kind: t(publishKindPhrase(call.review.kind)),
              title: call.review.title
            })
          : asker === "agent"
            ? t(
                changing
                  ? "operations.confirmHeadlineAgentChanging"
                  : "operations.confirmHeadlineAgentReading",
                { agent }
              )
            : t(
                changing
                  ? "operations.confirmHeadlineCliChanging"
                  : "operations.confirmHeadlineCliReading"
              )}
      </p>
      {summary ? (
        <p className="text-foreground wrap-anywhere" data-testid="operation-call-summary">
          {summary}
        </p>
      ) : null}
      <p className="text-foreground" data-testid="confirmation-waits">
        {t(WAITS[asker])}
      </p>
      <p className="text-caption text-muted-foreground">{t(EFFECT[asker])}</p>
      <Banner layout="line" role="note" data-testid="confirmation-only-you">
        {t("operations.confirmOnlyYou")}
      </Banner>
    </div>
  );
}
