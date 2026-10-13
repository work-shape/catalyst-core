import { ShieldAlert, ShieldX } from "lucide-react";
import type { ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  Chip,
  EmptyState,
  InlineError,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  Page,
  PageHeader,
  PageOutline,
  Section,
  SkeletonList
} from "@vivd-catalyst/ui";
import type { GuardrailHitView } from "@vivd-catalyst/api-client";
import { formatMomentShort } from "../control-plane/locale-format";
import { useTranslation, type TranslationKey } from "../i18n";
import { useInboxItemKindLookup } from "../inbox/inbox-item-kinds";
import { AssetIdentifier, usePageShown } from "./asset-editor-shell";
import type { BuildAssetViewProps } from "./build-asset-kind";
import { GUARDRAIL_OUTCOME_VIEWS, readGuardrail } from "./guardrail-model";
import type { GuardrailHitsRead, GuardrailSource } from "./guardrail-source";

/** The before-events in words. An event this build does not know shows as its name. */
const EVENT_LABELS: Record<string, TranslationKey> = {
  "approval_request.before_create": "guardrails.eventApprovalRequest"
};

/** The kind of what a hit checked, in words: the Inbox's name for a kind of request. */
function useSubjectLabel(): (kind: string) => string {
  const { t } = useTranslation();
  const lookup = useInboxItemKindLookup();
  return (kind) => t(lookup(kind)?.label ?? "inbox.kindUnknown");
}

/**
 * The page of one Guardrail: what it checks and when, what a hit does, and the newest hits.
 * Release config defines every Guardrail so far, so the page changes nothing.
 */
export function GuardrailPage({
  page,
  back,
  asset,
  source
}: BuildAssetViewProps & { source: GuardrailSource }) {
  const { t } = useTranslation();
  usePageShown(page, "asset");
  const hits = source.useHits(asset.name);
  const subjectLabel = useSubjectLabel();
  const guardrail = readGuardrail(asset.config);
  const outcome = GUARDRAIL_OUTCOME_VIEWS[guardrail.outcome];
  const eventLabel = EVENT_LABELS[guardrail.event];
  const sections: {
    id: string;
    label: string;
    description: string;
    count?: number;
    body: ReactNode;
  }[] = [
    {
      id: "check",
      label: t("guardrails.checkTitle"),
      description: t("guardrails.checkDescription"),
      body: (
        <>
          <AssetIdentifier name={asset.name} />
          <KeyValueList>
            <KeyValue label={t("guardrails.when")}>
              {eventLabel ? (
                t(eventLabel)
              ) : (
                <code className="font-mono text-code">{guardrail.event}</code>
              )}
            </KeyValue>
            <KeyValue label={t("guardrails.appliesTo")}>
              {guardrail.appliesTo === undefined
                ? t("guardrails.appliesToEvery")
                : subjectLabel(guardrail.appliesTo)}
            </KeyValue>
            <KeyValue label={t("guardrails.checkKind")}>{t("guardrails.checkModelJudge")}</KeyValue>
            <KeyValue label={t("guardrails.onHit")}>
              <div className="grid justify-items-start gap-1">
                <Badge tone={outcome.tone} dot>
                  {t(outcome.label)}
                </Badge>
                <span className="text-caption text-muted-foreground">{t(outcome.text)}</span>
              </div>
            </KeyValue>
            {guardrail.description ? (
              <KeyValue label={t("guardrails.descriptionLabel")} foldable>
                {guardrail.description}
              </KeyValue>
            ) : null}
            {guardrail.instruction ? (
              <KeyValue label={t("guardrails.rule")} foldable>
                <span className="whitespace-pre-line">{guardrail.instruction}</span>
              </KeyValue>
            ) : null}
          </KeyValueList>
        </>
      )
    },
    {
      id: "hits",
      label: t("guardrails.hitsTitle"),
      description: t("guardrails.hitsDescription"),
      count: hits.status === "ready" ? hits.hits.items.length : undefined,
      body: <GuardrailHitList read={hits} subjectLabel={subjectLabel} />
    }
  ];

  return (
    <Page
      width="narrow"
      ref={page.ref}
      header={
        <PageHeader
          variant="detail"
          back={back}
          title={guardrail.title ?? asset.name}
          scope={<Chip>{t("guardrails.scopeInstance")}</Chip>}
          state={
            <Badge tone={outcome.tone} dot>
              {t(outcome.label)}
            </Badge>
          }
        />
      }
      outline={
        <PageOutline
          belowHeader
          items={sections.map(({ id, label, count }) => ({ id, label, count }))}
        />
      }
    >
      {page.above}
      {/* The first line of the content starts where the outline does. */}
      <div className="grid min-w-0 content-start pt-5">
        <Banner layout="line" className="mb-4" data-build-read-only="">
          {t("guardrails.description")}
        </Banner>
        {sections.map((section) => (
          <Section
            key={section.id}
            id={section.id}
            layout="stacked"
            title={section.label}
            description={section.description}
            count={section.count}
          >
            {section.body}
          </Section>
        ))}
      </div>
    </Page>
  );
}

/** The newest hits, the newest first: who acted, on what, why, and when. */
function GuardrailHitList({
  read,
  subjectLabel
}: {
  read: GuardrailHitsRead;
  subjectLabel(kind: string): string;
}) {
  const { locale, t } = useTranslation();
  if (read.status === "loading") {
    return <SkeletonList rows={3} />;
  }
  if (read.status === "failed") {
    return (
      <InlineError className="flex flex-wrap items-center justify-between gap-2">
        <span>{read.message ?? t("guardrails.hitsFailed")}</span>
        <Button variant="outline" size="sm" onClick={read.retry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }
  const { items, hasMore } = read.hits;
  if (items.length === 0) {
    return <EmptyState layout="inline">{t("guardrails.hitsEmpty")}</EmptyState>;
  }
  return (
    <>
      <List aria-label={t("guardrails.hitsTitle")}>
        {items.map((hit: GuardrailHitView) => {
          const view = GUARDRAIL_OUTCOME_VIEWS[hit.outcome];
          const Icon = hit.outcome === "block" ? ShieldX : ShieldAlert;
          return (
            <ListRow
              key={hit.id}
              data-guardrail-hit={hit.outcome}
              leading={<Icon aria-hidden="true" className="size-4 text-muted-foreground" />}
              title={t("guardrails.hitTitle", {
                actor: hit.actor.displayLabel,
                subject: subjectLabel(hit.subjectKind)
              })}
              chips={
                <Badge tone={view.tone} size="sm">
                  {t(view.hitLabel)}
                </Badge>
              }
              description={hit.message || t("guardrails.hitUnevaluated")}
              descriptionWraps
              time={formatMomentShort(hit.createdAt, locale)}
            />
          );
        })}
      </List>
      {hasMore ? (
        <p className="pt-2 text-caption text-muted-foreground">
          {t("guardrails.hitsMore", { count: items.length })}
        </p>
      ) : null}
    </>
  );
}
