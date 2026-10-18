// @rights-screen: included in the rights wording guard.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Badge,
  Banner,
  Button,
  FormNotice,
  InlineError,
  List,
  ListRow,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { PendingApprovalError } from "../build-area/build-refusals";
import {
  giveFailureSentence,
  grantKey,
  lackingAccounts,
  neededRightLabel,
  offeredGrants,
  rightRefusalSentence,
  type WorkflowAccountRightsView,
  type WorkflowNeededRightView,
  type WorkflowPublishRightsView,
  type WorkflowRightGrant
} from "./workflow-publish-rights-model";
import type { WorkflowPublishRightsSource } from "./source-shapes";
import { useWorkflowsSource } from "./workflow-source";

// In the question before a Workflow is published: the rights its technical accounts lack, for
// it and for each child it starts, and the one step that gives them, for whoever may. The
// instance says what is lacking and what the reader may give; each right is given through the
// ordinary grant write, which asks every rule again.

/** What the accounts of the publish lack, read when the question opens. */
export function WorkflowPublishRights({ workflow }: { workflow: string }) {
  const source = useWorkflowsSource();
  const rights = source.publishRights;
  return rights === undefined ? null : (
    <PublishRights workflow={workflow} rights={rights} sourceKey={source.key} />
  );
}

function PublishRights({
  workflow,
  rights,
  sourceKey
}: {
  workflow: string;
  rights: WorkflowPublishRightsSource;
  sourceKey: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ["workflow-publish-rights", sourceKey, workflow] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => rights.read(workflow, signal),
    staleTime: 0
  });
  if (query.isPending) {
    return (
      <section className="mt-3 grid gap-2" aria-busy="true" data-testid="workflow-publish-rights">
        <p className="text-caption text-muted-foreground">{t("workflowRights.loading")}</p>
        <SkeletonList rows={2} />
      </section>
    );
  }
  if (query.isError) {
    return (
      <Banner layout="line" tone="warning" className="mt-3" data-testid="workflow-publish-rights">
        {t("workflowRights.loadFailed")}
      </Banner>
    );
  }
  return (
    <RightsLacking
      view={query.data}
      give={rights.give}
      onGiven={() => queryClient.invalidateQueries({ queryKey })}
    />
  );
}

/** The rights the accounts lack, and the confirmed step that gives what the reader may. */
export function RightsLacking({
  view,
  give,
  onGiven
}: {
  view: WorkflowPublishRightsView;
  give(grant: WorkflowRightGrant): Promise<void>;
  onGiven(): Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const [given, setGiven] = useState(false);
  const accounts = lackingAccounts(view);
  const offered = offeredGrants(view);
  const hidden = view.hiddenWorkflows;
  if (accounts.length === 0 && hidden === 0) {
    return (
      <FormNotice tone="success" className="mt-3" data-testid="workflow-publish-rights">
        {given ? t("workflowRights.given") : t("workflowRights.allHeld")}
      </FormNotice>
    );
  }
  const giveAll = async () => {
    setBusy(true);
    const failures = new Map<string, string>();
    // One write per right, each asked by every rule; a refusal stays on its own line.
    for (const grant of offered) {
      try {
        await give(grant);
      } catch (error) {
        failures.set(
          grantKey(grant),
          error instanceof PendingApprovalError
            ? t("workflowRights.giveHeld")
            : giveFailureSentence(error, t)
        );
      }
    }
    setFailed(failures);
    setGiven(failures.size === 0);
    setConfirming(false);
    setBusy(false);
    await onGiven();
  };
  const notAdministrator = accounts.some((entry) =>
    entry.rights.some((right) => right.refusal === "not_administrator")
  );
  return (
    <section
      className="mt-3 grid gap-3"
      aria-label={t("workflowRights.title")}
      data-testid="workflow-publish-rights"
    >
      <div className="grid gap-1">
        <h3 className="text-caption font-medium text-muted-foreground">
          {t("workflowRights.title")}
        </h3>
        <p className="text-body text-foreground">{t("workflowRights.missingIntro")}</p>
      </div>
      {accounts.map((entry) => (
        <AccountRights key={entry.workflow} entry={entry} failed={failed} />
      ))}
      {hidden === 0 ? null : (
        <Banner layout="line" tone="info" data-testid="workflow-publish-rights-hidden">
          {hidden === 1
            ? t("workflowRights.hiddenChild")
            : t("workflowRights.hiddenChildren", { count: hidden })}
        </Banner>
      )}
      {notAdministrator ? (
        <Banner layout="line" tone="info" data-testid="workflow-publish-rights-who">
          {t("workflowRights.whoGives")}
        </Banner>
      ) : null}
      {offered.length === 0 ? null : confirming ? (
        <Banner
          tone="warning"
          data-testid="workflow-publish-rights-confirm"
          action={
            <>
              <Button
                size="sm"
                loading={busy}
                onClick={() => {
                  giveAll().catch(() => undefined);
                }}
              >
                {t("workflowRights.giveConfirmButton")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                {t("workflowRights.giveCancel")}
              </Button>
            </>
          }
        >
          {t("workflowRights.giveConfirm", { count: offered.length })}
        </Banner>
      ) : (
        <div>
          <Button
            size="sm"
            variant="outline"
            data-testid="workflow-publish-rights-give"
            onClick={() => setConfirming(true)}
          >
            {offered.length === 1
              ? t("workflowRights.giveOne")
              : t("workflowRights.give", { count: offered.length })}
          </Button>
        </div>
      )}
    </section>
  );
}

function AccountRights({
  entry,
  failed
}: {
  entry: WorkflowAccountRightsView;
  failed: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const account = entry.account.label ?? entry.runAs;
  return (
    <div className="grid gap-1" data-workflow={entry.workflow}>
      <p className="text-caption text-muted-foreground">
        {t(entry.revision === "draft" ? "workflowRights.runsAs" : "workflowRights.childRunsAs", {
          workflow: entry.workflow,
          account
        })}
      </p>
      {entry.account.status === "unknown" ? (
        <InlineError>{t("workflowRights.accountMissing", { name: entry.runAs })}</InlineError>
      ) : entry.account.status === "disabled" ? (
        <InlineError>{t("workflowRights.accountDisabled", { account })}</InlineError>
      ) : null}
      {entry.rights.length === 0 ? null : (
        <List>
          {entry.rights.map((right, index) => (
            <NeededRight
              key={`${index} ${right.action} ${right.asset.kind}`}
              right={right}
              failure={
                right.grant
                  ? failed.get(grantKey({ ...right.grant, action: right.action }))
                  : undefined
              }
            />
          ))}
        </List>
      )}
    </div>
  );
}

function NeededRight({
  right,
  failure
}: {
  right: WorkflowNeededRightView;
  failure: string | undefined;
}) {
  const { t } = useTranslation();
  // Whoever administers no account is told so once, under the list.
  const refusal =
    right.refusal === undefined || right.refusal === "not_administrator"
      ? undefined
      : rightRefusalSentence(right.refusal, t);
  return (
    <ListRow
      size="default"
      descriptionWraps="always"
      title={neededRightLabel(right, t)}
      chips={
        <Badge size="sm" tone={right.neededFor === "publish" ? "warning" : "neutral"}>
          {t(
            right.neededFor === "publish"
              ? "workflowRights.neededToPublish"
              : "workflowRights.neededToRun"
          )}
        </Badge>
      }
      description={
        failure !== undefined ? (
          <InlineError>{failure}</InlineError>
        ) : (
          (refusal ?? t("workflowRights.steps", { steps: right.steps.join(", ") }))
        )
      }
    />
  );
}
