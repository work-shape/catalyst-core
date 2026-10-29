import { Banner } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { AppPublishHandover } from "./app-data";

// The widening check in the App's publish question (DS-13c): the instance asks it on the server
// and words it; the question only shows its answer. Where it holds, one plain line; where the
// publish hands a source's data to people who may not use the source, a warning with how many
// and who confirms. Nobody is named. Publish stays possible: a publish nobody confirmed waits
// in the Inbox for a person who may change the source.
//
// An agent's publish card never confirms a hand-over: only a person's click in the Publish
// dialog does. The card says so instead of the dialog's sentence on who confirms.

export function AppPublishHandoverView({
  handover,
  agentCard = false
}: {
  handover: AppPublishHandover | undefined;
  /** Shown on an agent's publish card, which cannot confirm the hand-over. */
  agentCard?: boolean;
}) {
  const { t } = useTranslation();
  if (handover === undefined || handover.lines.length === 0) return null;
  if (handover.holds) {
    return (
      <p
        className="text-body text-muted-foreground wrap-anywhere"
        data-testid="app-publish-handover"
      >
        {handover.lines.join(" ")}
      </p>
    );
  }
  return (
    <Banner
      tone="warning"
      role="note"
      title={t("apps.publishHandover")}
      data-testid="app-publish-handover"
    >
      {agentCard ? (
        <p className="wrap-anywhere">{t("apps.publishHandoverInDialog")}</p>
      ) : (
        <ul className="grid gap-1">
          {handover.lines.map((line) => (
            <li key={line} className="wrap-anywhere">
              {line}
            </li>
          ))}
        </ul>
      )}
    </Banner>
  );
}
