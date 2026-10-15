import { Badge, Banner, KeyValue, KeyValueList } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../i18n";
import type { PublishChange, PublishReview, PublishStale } from "./operation-call-preview";

const STALE: Record<PublishStale, TranslationKey> = {
  gone: "operations.publishStaleGone",
  draft_moved: "operations.publishStaleDraft",
  live_moved: "operations.publishStaleLive"
};

const CHANGE: Record<PublishChange["change"], TranslationKey> = {
  new: "operations.publishChangeNew",
  changed: "operations.publishChangeChanged",
  added: "operations.publishChangeAdded",
  removed: "operations.publishChangeRemoved"
};

/** How the item names the kind it publishes. Another kind is "the asset". */
const KIND_PHRASE: Record<string, TranslationKey> = {
  app: "operations.publishKindApp",
  workflow: "operations.publishKindWorkflow"
};

/**
 * A publish that waits for an approver (GR-PUB-1): who wants to make which version live, what
 * approving does, and the review against the live version: the files that differ, the changing
 * actions or steps that are new or changed, the outside hosts it adds, the Connections, Data
 * Stores and account it uses. A request whose draft or live version moved says it cannot be
 * approved.
 */
export function PublishReviewBody({ actor, review }: { actor: string; review: PublishReview }) {
  const { t } = useTranslation();
  const none = <span className="text-muted-foreground">{t("operations.publishNone")}</span>;
  const names = (list: readonly string[]) => (list.length === 0 ? none : list.join(", "));
  const changes = (list: readonly PublishChange[]) =>
    list.length === 0 ? (
      none
    ) : (
      <ul className="grid gap-1">
        {list.map((entry) => (
          <li key={entry.label} className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="wrap-anywhere">{entry.label}</span>
            <Badge tone="neutral">{t(CHANGE[entry.change])}</Badge>
          </li>
        ))}
      </ul>
    );
  return (
    <section className="grid min-w-0 gap-4" data-testid="publish-review">
      <div className="grid min-w-0 gap-1.5">
        <p className="font-medium text-foreground" data-testid="operation-call-headline">
          {t("operations.publishHeadline", {
            actor,
            kind: t(KIND_PHRASE[review.kind] ?? "operations.publishKindOther"),
            title: review.title
          })}
        </p>
        <p className="text-caption text-muted-foreground">{t("operations.publishEffect")}</p>
      </div>
      {review.stale ? (
        <Banner tone="warning" role="note" data-testid="publish-review-stale">
          {t(STALE[review.stale])}
        </Banner>
      ) : null}
      <KeyValueList layout="stacked">
        <KeyValue label={t("operations.publishVersion")} data-field="version">
          {review.liveRevision === undefined
            ? t("operations.publishFirst", { number: review.revision })
            : t("operations.publishReplaces", {
                number: review.revision,
                live: review.liveRevision
              })}
        </KeyValue>
        <KeyValue label={t("operations.publishFiles")} data-field="files">
          {changes(review.files)}
        </KeyValue>
        {review.changing ? (
          <KeyValue label={t("operations.publishChanging")} data-field="changing">
            {changes(review.changing)}
          </KeyValue>
        ) : null}
        {review.kind === "app" ? (
          <KeyValue label={t("operations.publishHosts")} data-field="hosts">
            {names(review.hostsAdded)}
          </KeyValue>
        ) : null}
        <KeyValue label={t("operations.publishConnections")} data-field="connections">
          {names(review.connections)}
        </KeyValue>
        {review.kind === "app" ? (
          <KeyValue label={t("operations.publishDataStores")} data-field="data-stores">
            {names(
              review.dataStores.map((store) =>
                store.minSchema === undefined
                  ? store.name
                  : t("operations.publishDataStoreLevel", {
                      name: store.name,
                      level: store.minSchema
                    })
              )
            )}
          </KeyValue>
        ) : null}
        {review.runAs ? (
          <KeyValue label={t("operations.publishRunsAs")} data-field="runs-as">
            {review.runAs}
          </KeyValue>
        ) : null}
      </KeyValueList>
    </section>
  );
}
