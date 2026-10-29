import { Banner } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { AppPublishHandover } from "./app-data";

// The widening check in the App's publish question (DS-13c): the instance asks it on the server
// and words it; the question only shows its answer. Where it holds, one plain line; where the
// publish hands a source's data to people who may not use the source, a warning with how many
// and who confirms. Nobody is named.

/** Whether Publish may be sent: the check holds, or the reader may confirm the hand-over. */
export function appPublishHandoverAllows(handover: AppPublishHandover | undefined): boolean {
  return handover === undefined || handover.holds || handover.confirmation !== undefined;
}

export function AppPublishHandoverView({ handover }: { handover: AppPublishHandover | undefined }) {
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
      <ul className="grid gap-1">
        {handover.lines.map((line) => (
          <li key={line} className="wrap-anywhere">
            {line}
          </li>
        ))}
      </ul>
    </Banner>
  );
}
