import { Banner, Disclosure, DisclosureContent, DisclosureTrigger } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { failureAdvice, failureHappened, type FailureNames } from "./workflow-model";
import type { WorkflowFailure } from "./workflow-views";
import { useWorkflowsHost } from "./workflows-host";

/**
 * Why a step or a run failed: what happened, what the reader can do about it, and behind a
 * fold what the instance wrote. Contract need C5: until a failure carries its own sentence,
 * the sentence is the one of its reason, with the account and the Connection the screen knows.
 */
export function FailureBanner({
  failure,
  account,
  connection
}: { failure: WorkflowFailure } & FailureNames) {
  const { t } = useTranslation();
  const administers = useWorkflowsHost()?.rights.administersAccounts === true;
  // Where an administrator changes a Workflow's technical account, for the advice that names it.
  const place = `${t("nav.settings")} › ${t("settings.apiAccess")}`;
  const names = { account, connection };
  return (
    <Banner tone="danger" layout="inline">
      <p data-failure-happened="">{failureHappened(failure, t, names)}</p>
      <p data-failure-advice="">{failureAdvice(failure, t, { ...names, administers, place })}</p>
      <Disclosure className="mt-1">
        <DisclosureTrigger>{t("workflows.technicalDetails")}</DisclosureTrigger>
        <DisclosureContent>{failure.detail}</DisclosureContent>
      </Disclosure>
    </Banner>
  );
}
