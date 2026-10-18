import { Banner, Disclosure, DisclosureContent, DisclosureTrigger } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { failureHappened, failureSentences } from "./workflow-model";
import type { WorkflowFailure } from "./workflow-views";

/**
 * Why a step or a run failed: what happened, what the reader can do about it, and behind a
 * fold what the instance wrote. Contract need C5: until a failure carries its own sentence
 * and the Connection it concerns, the sentence is the one of its reason.
 */
export function FailureBanner({ failure }: { failure: WorkflowFailure }) {
  const { t } = useTranslation();
  const sentences = failureSentences(failure.reason);
  // Where an administrator changes a Workflow's technical account, for the advice that names it.
  const place = `${t("nav.settings")} › ${t("settings.apiAccess")}`;
  return (
    <Banner tone="danger" layout="inline">
      <p data-failure-happened="">{failureHappened(failure, t)}</p>
      <p data-failure-advice="">{t(sentences.advice, { place })}</p>
      <Disclosure className="mt-1">
        <DisclosureTrigger>{t("workflows.technicalDetails")}</DisclosureTrigger>
        <DisclosureContent>{failure.detail}</DisclosureContent>
      </Disclosure>
    </Banner>
  );
}
