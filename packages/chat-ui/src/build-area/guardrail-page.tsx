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
import { opensHere } from "../apps/app-header";
import { opensAssets, type BuildKind } from "./build-asset-kind";
import { useBuildNavigation } from "./build-route";
import {
  GUARDRAIL_HIT_LABELS,
  GUARDRAIL_OUTCOME_VIEWS,
  guardrailFactsOfView,
  readGuardrail,
  type GuardrailScope
} from "./guardrail-model";
import {
  WorkspaceNames,
  useGuardrailRunSentence,
  type WorkspaceNameOf
} from "./guardrail-run-line";
import type { GuardrailHitsRead, GuardrailSource } from "./guardrail-source";

/**
 * The kind of what a guardrail checks, in words: the Inbox's name for a kind of request, the
 * Build area's for a kind of asset, and the kind's id where neither knows it.
 */
function useSubjectLabel(kinds: readonly BuildKind[]): (event: string, kind: string) => ReactNode {
  const { t } = useTranslation();
  const lookup = useInboxItemKindLookup();
  return (event, kind) => {
    if (event === "approval_request.before_create") {
      return t(lookup(kind)?.label ?? "inbox.kindUnknown");
    }
    const built = kinds.find((candidate) => candidate.kind === kind);
    return built ? t(built.label) : <code className="font-mono text-code">{kind}</code>;
  };
}

/**
 * The page of one Guardrail: what it checks and when, what a hit does, and the newest hits.
 * The page changes nothing: release config defines the floor, and further Guardrails are
 * written with the CLI or the Build Agent until Build authors them (EW-6b).
 */
export function GuardrailPage({
  page,
  back,
  asset,
  kinds,
  source
}: BuildAssetViewProps & { source: GuardrailSource }) {
  const { t } = useTranslation();
  usePageShown(page, "asset");
  const hits = source.useHits(asset.name);
  const subjectLabel = useSubjectLabel(kinds);
  const runSentence = useGuardrailRunSentence();
  const guardrail = readGuardrail(asset.config);
  const outcome = GUARDRAIL_OUTCOME_VIEWS[guardrail.outcome];
  const scope: GuardrailScope =
    asset.scope.kind === "workspace"
      ? { kind: "workspace", workspaceId: asset.scope.workspaceId }
      : { kind: "instance" };
  const facts = guardrailFactsOfView(guardrail, scope);
  const code = (value: string) => <code className="font-mono text-code">{value}</code>;
  const sections = (
    nameOf: WorkspaceNameOf
  ): {
    id: string;
    label: string;
    description: string;
    count?: number;
    body: ReactNode;
  }[] => [
    {
      id: "check",
      label: t("guardrails.checkTitle"),
      description: t("guardrails.checkDescription"),
      body: (
        <>
          <AssetIdentifier name={asset.name} />
          <KeyValueList>
            <KeyValue label={t("guardrails.whenItRuns")}>
              <span data-guardrail-runs="">{runSentence(facts, nameOf)}</span>
            </KeyValue>
            <KeyValue label={t("guardrails.appliesTo")}>
              {guardrail.appliesTo === undefined
                ? t("guardrails.appliesToEvery")
                : subjectLabel(guardrail.event, guardrail.appliesTo)}
            </KeyValue>
            {guardrail.operation ? (
              <KeyValue label={t("guardrails.filterOperation")}>
                {code(guardrail.operation)}
              </KeyValue>
            ) : null}
            {guardrail.origin ? (
              <KeyValue label={t("guardrails.filterOrigin")}>{code(guardrail.origin)}</KeyValue>
            ) : null}
            {guardrail.agent ? (
              <KeyValue label={t("guardrails.filterAgent")}>{code(guardrail.agent)}</KeyValue>
            ) : null}
            <KeyValue label={t("guardrails.checkKind")}>
              {t(
                guardrail.checkKind === "pattern"
                  ? "guardrails.checkPattern"
                  : "guardrails.checkModelJudge"
              )}
            </KeyValue>
            {guardrail.pattern ? (
              <KeyValue label={t("guardrails.pattern")} foldable>
                <code className="font-mono text-code break-all">{guardrail.pattern}</code>
              </KeyValue>
            ) : null}
            {guardrail.fields ? (
              <KeyValue label={t("guardrails.checkedFields")}>
                {guardrail.fields.join(", ")}
              </KeyValue>
            ) : null}
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
      body: <GuardrailHitList read={hits} kinds={kinds} subjectLabel={subjectLabel} />
    }
  ];

  return <WorkspaceNames>{(nameOf) => render(nameOf)}</WorkspaceNames>;

  function render(nameOf: WorkspaceNameOf) {
    const shown = sections(nameOf);
    return (
      <Page
        width="narrow"
        ref={page.ref}
        header={
          <PageHeader
            variant="detail"
            back={back}
            title={guardrail.title ?? asset.name}
            scope={<Chip>{scopeLabel(scope, nameOf, t)}</Chip>}
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
            items={shown.map(({ id, label, count }) => ({ id, label, count }))}
          />
        }
      >
        {page.above}
        {/* The first line of the content starts where the outline does. */}
        <div className="grid min-w-0 content-start pt-5">
          <Banner layout="line" className="mb-4" data-build-read-only="">
            {t("guardrails.description")}
          </Banner>
          {shown.map((section) => (
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
}

/** Who the guardrail belongs to: the instance, or its workspace by name where it is known. */
function scopeLabel(
  scope: GuardrailScope,
  nameOf: WorkspaceNameOf,
  t: (key: TranslationKey, values?: Record<string, string>) => string
): string {
  if (scope.kind === "instance") return t("guardrails.scopeInstance");
  const name = nameOf(scope.workspaceId);
  return name === undefined
    ? t("guardrails.scopeSomeWorkspace")
    : t("guardrails.scopeWorkspace", { name });
}

/**
 * How often the guardrail fired, by period, and the newest hits, the newest first: on what, why,
 * and when. A hit on an asset of the Build area links it. No hit names a person: hits are
 * counted by rule and period, never listed by person (works-council co-determination, §87(1)
 * no. 6 BetrVG).
 */
function GuardrailHitList({
  read,
  kinds,
  subjectLabel
}: {
  read: GuardrailHitsRead;
  kinds: readonly BuildKind[];
  subjectLabel(event: string, kind: string): ReactNode;
}) {
  const { locale, t } = useTranslation();
  const { href, open } = useBuildNavigation();
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
  const { items, hasMore, counts } = read.hits;
  if (items.length === 0) {
    return <EmptyState layout="inline">{t("guardrails.hitsEmpty")}</EmptyState>;
  }
  return (
    <>
      <KeyValueList className="pb-3" data-guardrail-hit-counts="">
        <KeyValue label={t("guardrails.hitsLast7Days")}>{counts.last7Days}</KeyValue>
        <KeyValue label={t("guardrails.hitsLast30Days")}>{counts.last30Days}</KeyValue>
      </KeyValueList>
      <List aria-label={t("guardrails.hitsTitle")}>
        {items.map((hit: GuardrailHitView) => {
          const view = GUARDRAIL_OUTCOME_VIEWS[hit.outcome];
          const Icon = hit.outcome === "block" ? ShieldX : ShieldAlert;
          const kind = kinds.find((candidate) => candidate.kind === hit.subjectKind);
          const place =
            kind && hit.subjectName !== undefined && opensAssets(kind)
              ? { kindPath: kind.path, name: hit.subjectName }
              : undefined;
          return (
            <ListRow
              key={hit.id}
              data-guardrail-hit={hit.outcome}
              data-guardrail-hit-converted-from={hit.convertedFrom}
              data-guardrail-hit-subject={hit.subjectName}
              leading={<Icon aria-hidden="true" className="size-4 text-muted-foreground" />}
              title={
                hit.subjectKind === "operation" && hit.subjectName !== undefined ? (
                  t("guardrails.subjectOperation", { name: hit.subjectName })
                ) : hit.subjectName !== undefined ? (
                  <span className="font-mono">{hit.subjectName}</span>
                ) : (
                  subjectLabel(hit.event, hit.subjectKind)
                )
              }
              chips={
                <>
                  {hit.subjectName !== undefined && hit.subjectKind !== "operation" ? (
                    <Chip>{subjectLabel(hit.event, hit.subjectKind)}</Chip>
                  ) : null}
                  <Badge tone={view.tone} size="sm">
                    {t(
                      hit.convertedFrom === "require_approval"
                        ? "guardrails.hitBlockedApprovalCouldNotWait"
                        : GUARDRAIL_HIT_LABELS[hit.outcome]
                    )}
                  </Badge>
                </>
              }
              link={
                place ? (
                  <a
                    href={href(place)}
                    onClick={(event) => {
                      if (opensHere(event)) {
                        event.preventDefault();
                        open(place);
                      }
                    }}
                  />
                ) : undefined
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
