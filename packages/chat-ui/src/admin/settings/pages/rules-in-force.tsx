import { Fragment, useState } from "react";
import type { RuleInForceView, RulesInForceView } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Button,
  EmptyState,
  List,
  ListRow,
  LoadError,
  PageHeader,
  Section,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useRulesInForceQuery } from "../../../shared/api/rules-in-force";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";
import {
  AskAboutRule,
  changedLine,
  type AskClient
} from "../../../chat/guardrails/guardrail-answer";
import { changersSentence } from "../../../chat/guardrails/guardrail-answer-model";
import { GUARDRAIL_OUTCOME_VIEWS } from "../../../studio/build-area/guardrail-model";
import { useGuardrailRunSentence } from "../../../studio/build-area/guardrail-run-line";
import { SHIPPED_WORDS } from "../../../studio/build-area/shipped-guardrails";

/**
 * You > Rules in force (GR-3): the guardrails that apply to the person, read-only. The operator's
 * floor, the platform's switches and what is published for all workspaces or for the person's
 * workspaces, each with when it runs, what it does, who changed it and when, who can change it
 * and how often it answered in the last 30 days, a count and never who. Every signed-in person
 * opens it; every guardrail answer links here.
 */
export function RulesInForcePage() {
  const { apiBaseUrl, client } = useSettingsPage();
  const rules = useRulesInForceQuery({ apiBaseUrl, client });
  return (
    <RulesInForceList
      rules={rules.data}
      failed={rules.isError}
      client={client}
      onRetry={() => {
        rules.refetch().catch(() => undefined);
      }}
    />
  );
}

interface RuleGroup {
  key: string;
  title: string;
  description?: string;
  rules: RuleInForceView[];
}

/** The rules by where they come from: the floor, all workspaces, then each workspace. */
function groupsOf(rules: RulesInForceView, t: ReturnType<typeof useTranslation>["t"]): RuleGroup[] {
  const floor = rules.items.filter((rule) => rule.origin === "release");
  const instance = rules.items.filter(
    (rule) => rule.origin !== "release" && rule.scope.kind === "instance"
  );
  const workspaces = new Map<string, RuleGroup>();
  for (const rule of rules.items) {
    if (rule.origin === "release" || rule.scope.kind !== "workspace") continue;
    const { workspaceId, workspaceName } = rule.scope;
    const group = workspaces.get(workspaceId) ?? {
      key: `workspace:${workspaceId}`,
      title: workspaceName
        ? t("rulesInForce.workspace", { name: workspaceName })
        : t("rulesInForce.someWorkspace"),
      rules: []
    };
    group.rules.push(rule);
    workspaces.set(workspaceId, group);
  }
  return [
    {
      key: "floor",
      title: t("rulesInForce.floor"),
      description: t("rulesInForce.floorDescription"),
      rules: floor
    },
    { key: "instance", title: t("rulesInForce.instance"), rules: instance },
    ...workspaces.values()
  ].filter((group) => group.rules.length > 0);
}

export function RulesInForceList({
  rules,
  failed,
  client,
  onRetry
}: {
  rules: RulesInForceView | undefined;
  failed: boolean;
  client: AskClient;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const groups = rules ? groupsOf(rules, t) : [];
  return (
    <>
      <PageHeader title={t("settings.rulesInForce")} description={t("rulesInForce.description")} />
      {failed ? (
        <LoadError onRetry={onRetry}>{t("rulesInForce.loadFailed")}</LoadError>
      ) : !rules ? (
        <SkeletonList rows={3} />
      ) : groups.length === 0 ? (
        <EmptyState layout="inline">{t("rulesInForce.empty")}</EmptyState>
      ) : (
        groups.map((group) => (
          <Section
            key={group.key}
            layout="stacked"
            title={group.title}
            count={group.rules.length}
            {...(group.description ? { description: group.description } : {})}
            data-testid="rules-in-force-group"
            data-group={group.key}
          >
            <List>
              {group.rules.map((rule) => (
                <RuleRow
                  key={`${rule.origin}:${rule.name}`}
                  rule={rule}
                  instanceAdmin={rules.instanceAdmin}
                  client={client}
                />
              ))}
            </List>
          </Section>
        ))
      )}
    </>
  );
}

const SHIPPED_STATE: Record<"on" | "always" | "off", "text" | "alwaysText" | "offText"> = {
  on: "text",
  always: "alwaysText",
  off: "offText"
};

function RuleRow({
  rule,
  instanceAdmin,
  client
}: {
  rule: RuleInForceView;
  instanceAdmin: string | undefined;
  client: AskClient;
}) {
  const { t, locale } = useTranslation();
  const sentence = useGuardrailRunSentence();
  const [asking, setAsking] = useState(false);
  const outcome = GUARDRAIL_OUTCOME_VIEWS[rule.outcome];
  const shipped = rule.origin === "shipped" ? SHIPPED_WORDS[rule.name] : undefined;
  const off = rule.origin === "shipped" && rule.enabled === false;
  const title = shipped ? t(shipped.title) : rule.displayName;
  const shippedKey: TranslationKey | undefined = shipped
    ? shipped[SHIPPED_STATE[off ? "off" : rule.alwaysAsk ? "always" : "on"]]
    : undefined;
  const runs =
    shippedKey !== undefined
      ? t(shippedKey)
      : rule.origin === "shipped" || rule.on[0] === undefined
        ? undefined
        : sentence(
            {
              event: rule.on[0],
              outcome: rule.outcome,
              ...(rule.checkKind ? { checkKind: rule.checkKind } : {}),
              ...filterFacts(rule.filter),
              scope:
                rule.scope.kind === "instance"
                  ? { kind: "instance" }
                  : { kind: "workspace", workspaceId: rule.scope.workspaceId },
              setByOperator: rule.origin === "release"
            },
            (id) =>
              rule.scope.kind === "workspace" && rule.scope.workspaceId === id
                ? rule.scope.workspaceName
                : undefined
          );
  const reason = shipped ? undefined : rule.reason || undefined;
  const changed = changedLine(rule, rule.revision, t, locale);
  const who = rule.origin === "release" ? undefined : changersSentence(rule, rule, instanceAdmin);
  const hits =
    rule.hitsLast30Days > 0
      ? t("rulesInForce.hits", { count: rule.hitsLast30Days })
      : t("rulesInForce.noHits");
  return (
    <Fragment>
      <ListRow
        data-testid="rule-in-force"
        data-rule={rule.name}
        data-origin={rule.origin}
        title={title}
        chips={
          <>
            <Badge tone={outcome.tone} dot>
              {t(outcome.label)}
            </Badge>
            {off ? <Badge tone="neutral">{t("rulesInForce.off")}</Badge> : null}
            {rule.revision === undefined ? null : (
              <Badge tone="neutral" appearance="outline">
                {t("guardrailAnswer.revision", { revision: rule.revision })}
              </Badge>
            )}
          </>
        }
        descriptionWraps="always"
        description={
          <>
            {runs ? <span className="block">{runs}</span> : null}
            {reason ? (
              <span className="block text-foreground" data-testid="rule-in-force-reason">
                {reason}
              </span>
            ) : null}
            {changed ? <span className="block">{changed}</span> : null}
            {who ? (
              <span className="block" data-testid="rule-in-force-who">
                {t(who.key, who.values)}
              </span>
            ) : null}
            <span className="block" data-testid="rule-in-force-hits">
              {hits}
            </span>
          </>
        }
        actionsVisible
        actions={
          rule.askable && !asking ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="rule-in-force-ask"
              aria-label={`${t("rulesInForce.ask")}: ${title}`}
              onClick={() => setAsking(true)}
            >
              {t("rulesInForce.ask")}
            </Button>
          ) : undefined
        }
      />
      {asking ? (
        <li className="min-w-0 px-2 pb-3">
          <AskAboutRule name={rule.name} client={client} onCancel={() => setAsking(false)} />
        </li>
      ) : null}
    </Fragment>
  );
}

/** What a filter narrows by, as the run sentence names it. */
function filterFacts(filter: Record<string, string> | undefined) {
  if (!filter) return {};
  return {
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.operation ? { operation: filter.operation } : {}),
    ...(filter.origin ? { callOrigin: filter.origin } : {}),
    ...(filter.agent ? { agent: filter.agent } : {}),
    ...(filter.workspace ? { workspace: filter.workspace } : {})
  };
}
