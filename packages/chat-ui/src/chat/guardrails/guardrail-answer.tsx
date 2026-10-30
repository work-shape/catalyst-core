import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiClient, RuleInForceView } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  Field,
  FormNotice,
  Spinner,
  TextLink,
  Textarea,
  type BannerTone
} from "@work-shape/catalyst-ui";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useAskAboutRule, useRulesInForceQuery } from "../../shared/api/rules-in-force";
import { useTranslation } from "../../shared/i18n";
import { formatMomentShort } from "../../shared/locale-format";
import { workspaceRoutePath } from "../../shared/routes";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { GUARDRAIL_OUTCOME_VIEWS } from "../../studio/build-area/guardrail-model";
import { SHIPPED_WORDS } from "../../studio/build-area/shipped-guardrails";
import { useApprovalRevisionHost } from "../approvals/approval-revision-host";
import { changersSentence, type GuardrailAnswerRef } from "./guardrail-answer-model";
import { chatInputRuleWords } from "./chat-input-rule-words";

// A guardrail's answer where the person acts (GR-3): its name, its reason, what it did, where it
// applies and in which version, who can change it, a way to ask them, and the way to Rules in
// force. The rule is looked up in Rules in force, which names only the people this reader may see.

const BANNER_TONES: Record<GuardrailAnswerRef["outcome"], BannerTone> = {
  allow: "info",
  warn: "warning",
  require_approval: "info",
  block: "danger"
};

export type AskClient = { guardrails: Pick<ApiClient["guardrails"], "ask"> };

/** The longest question a person sends, as the instance takes it. */
const QUESTION_MAX_CHARS = 1_000;

const RULES_IN_FORCE_ROUTE: WorkspaceRoute = {
  kind: "settings",
  group: "you",
  page: "rules"
};

/** The answers of the guardrails on one call, one under the other. */
export function GuardrailAnswers({ answers }: { answers: readonly GuardrailAnswerRef[] }) {
  if (answers.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-2" data-testid="guardrail-answers">
      {answers.map((answer) => (
        <GuardrailAnswer key={`${answer.origin}:${answer.name}`} answer={answer} />
      ))}
    </div>
  );
}

/** One guardrail's answer, with the rule as Rules in force shows it to this reader. */
export function GuardrailAnswer({
  answer,
  onDismiss
}: {
  answer: GuardrailAnswerRef;
  /** Shows a dismiss button, where the answer stands over something else. */
  onDismiss?(): void;
}) {
  const api = useOptionalWorkspaceApiClient();
  const rules = useRulesInForceQuery({ apiBaseUrl: api?.apiBaseUrl ?? "", client: api?.client });
  const rule = rules.data?.items.find(
    (item) => item.name === answer.name && item.origin === answer.origin
  );
  // A rule published since the list was read is read again, once.
  const missing = rules.data !== undefined && rule === undefined;
  const reread = useRef(false);
  const { refetch } = rules;
  useEffect(() => {
    if (!missing || reread.current) return;
    reread.current = true;
    refetch().catch(() => undefined);
  }, [missing, refetch]);
  return (
    <GuardrailAnswerView
      answer={answer}
      rule={rule}
      pending={api !== undefined && (rules.isPending || (missing && rules.isFetching))}
      instanceAdmin={rules.data?.instanceAdmin}
      client={rule?.askable ? api?.client : undefined}
      {...(onDismiss ? { onDismiss } : {})}
    />
  );
}

/** The answer as drawn, from the answer and the rule this reader was shown. */
export function GuardrailAnswerView({
  answer,
  rule,
  pending = false,
  instanceAdmin,
  client,
  onDismiss
}: {
  answer: GuardrailAnswerRef;
  rule: RuleInForceView | undefined;
  /** The rule is still being read: who can change it is not said yet. */
  pending?: boolean;
  instanceAdmin: string | undefined;
  /** Where the reader can ask who can change the rule: never for the operator's floor. */
  client: AskClient | undefined;
  onDismiss?(): void;
}) {
  const { t, locale } = useTranslation();
  const host = useApprovalRevisionHost();
  const [asking, setAsking] = useState(false);
  const outcome = GUARDRAIL_OUTCOME_VIEWS[answer.outcome];
  // A guardrail the platform ships reads in the reader's language.
  const shipped = answer.origin === "shipped" ? SHIPPED_WORDS[answer.name] : undefined;
  // So does a default rule on chat input that the operator left as it is (GR-4).
  const chatInput = chatInputRuleWords(answer);
  const title = shipped ? t(shipped.title) : chatInput ? t(chatInput.title) : answer.title;
  const reason = chatInput ? t(chatInput.reason) : (answer.reason ?? (rule?.reason || undefined));
  const scope = answer.scope ?? rule?.scope;
  const workspaceName = rule?.scope.kind === "workspace" ? rule.scope.workspaceName : undefined;
  const revision = answer.revision ?? rule?.revision;
  const facts = [
    t(outcome.label),
    scope === undefined
      ? undefined
      : scope.kind === "instance"
        ? t("guardrailAnswer.scopeInstance")
        : workspaceName
          ? t("guardrailAnswer.scopeWorkspace", { name: workspaceName })
          : t("guardrailAnswer.scopeSomeWorkspace"),
    revision === undefined ? undefined : t("guardrailAnswer.revision", { revision })
  ].filter((fact): fact is string => fact !== undefined);
  const who = changersSentence(rule, answer, instanceAdmin);
  const changed = changedLine(rule, revision, t, locale);
  const route = RULES_IN_FORCE_ROUTE;

  return (
    <div
      className="grid min-w-0 gap-2"
      role="group"
      aria-label={t("guardrailAnswer.label", { title })}
      data-testid="guardrail-answer"
      data-guardrail={answer.name}
      data-outcome={answer.outcome}
    >
      <Banner
        tone={BANNER_TONES[answer.outcome]}
        role="note"
        {...(onDismiss ? { onDismiss } : {})}
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="wrap-anywhere">{t("guardrailAnswer.title", { title })}</span>
            <Badge tone={outcome.tone} size="sm">
              {t(outcome.label)}
            </Badge>
          </span>
        }
      >
        {reason ? (
          <span className="block wrap-anywhere" data-testid="guardrail-answer-reason">
            {reason}
          </span>
        ) : null}
        {answer.outcome === "require_approval" ? (
          <span className="block">
            {t(
              answer.approvalCannotWait
                ? "guardrailAnswer.approvalCannotWait"
                : "guardrailAnswer.approvalAsked"
            )}
          </span>
        ) : null}
        {answer.approvalCannotWait && answer.outcome === "block" ? (
          <span className="block">{t("guardrailAnswer.approvalCannotWait")}</span>
        ) : null}
        <span className="block text-caption" data-testid="guardrail-answer-facts">
          {facts.join(" · ")}
        </span>
        {pending ? null : (
          <span className="block text-caption" data-testid="guardrail-answer-who">
            {t(who.key, who.values)}
            {changed ? ` ${changed}` : ""}
          </span>
        )}
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {client && !asking ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="guardrail-answer-ask"
              onClick={() => setAsking(true)}
            >
              {t("guardrailAnswer.ask")}
            </Button>
          ) : null}
          <TextLink
            className="text-caption underline"
            href={workspaceRoutePath(route)}
            data-testid="guardrail-answer-rules"
            onClick={(event) => {
              if (!host?.openRoute || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              host.openRoute(route);
            }}
          >
            {t("guardrailAnswer.rulesLink")}
          </TextLink>
        </span>
      </Banner>
      {asking && client ? (
        <AskAboutRule name={answer.name} client={client} onCancel={() => setAsking(false)} />
      ) : null}
    </div>
  );
}

/** Who published the version or switched the rule last, and when, where the reader may know. */
export function changedLine(
  rule: RuleInForceView | undefined,
  revision: number | undefined,
  t: ReturnType<typeof useTranslation>["t"],
  locale: ReturnType<typeof useTranslation>["locale"]
): string | undefined {
  if (!rule || rule.origin === "release") return undefined;
  const when = rule.changedAt ? formatMomentShort(rule.changedAt, locale) : undefined;
  if (rule.origin === "shipped") {
    return rule.changedBy && when
      ? t("guardrailAnswer.switchedBy", { name: rule.changedBy, when })
      : rule.changedByHidden
        ? undefined
        : t("guardrailAnswer.asShipped");
  }
  const shown = revision ?? rule.revision;
  if (shown === undefined || when === undefined) return undefined;
  return rule.changedBy
    ? t("guardrailAnswer.publishedBy", { revision: shown, name: rule.changedBy, when })
    : t("guardrailAnswer.publishedByHidden", { revision: shown, when });
}

/**
 * The person's question about a rule, sent to the Inbox of who can change it. The question is
 * theirs; the instance adds the rule's name and who asks.
 */
export function AskAboutRule({
  name,
  client,
  onCancel
}: {
  name: string;
  client: AskClient;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const ask = useAskAboutRule(client);
  const [text, setText] = useState("");

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    ask.mutate({ name, text: trimmed });
  }

  if (ask.isSuccess) {
    return (
      <FormNotice tone="success" data-testid="guardrail-answer-asked">
        {ask.data.addressees === 1
          ? t("guardrailAnswer.askedOne")
          : t("guardrailAnswer.asked", { count: ask.data.addressees })}
      </FormNotice>
    );
  }
  return (
    <form className="grid min-w-0 gap-2" onSubmit={send} data-testid="guardrail-answer-ask-form">
      <Field label={t("guardrailAnswer.askLabel")} hint={t("guardrailAnswer.askHint")}>
        <Textarea
          autoFocus
          rows={2}
          maxLength={QUESTION_MAX_CHARS}
          value={text}
          disabled={ask.isPending}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={ask.isPending || text.trim().length === 0}>
          {t("guardrailAnswer.askSend")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={ask.isPending}
          onClick={onCancel}
        >
          {t("guardrailAnswer.askCancel")}
        </Button>
        {ask.isPending ? <Spinner size="sm" /> : null}
      </div>
      {ask.isError ? <FormNotice tone="error">{t("guardrailAnswer.askFailed")}</FormNotice> : null}
    </form>
  );
}
