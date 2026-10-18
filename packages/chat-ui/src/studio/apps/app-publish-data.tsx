import { Banner, Button, InlineError, KeyValue, SkeletonList } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { useAppPublishData, type AppPublishDataRead } from "./app-data";
import { appReadsStoredData } from "./app-model";

// The lines of the publish question on stored data (DS-13b): who may use the App, and which
// stored data its reading actions show them. The App's Publish dialog and the Inbox item of a
// held publish show the same lines, each for the revision it would make live. They stand inside
// the KeyValueList of the question that holds them.

/** The lines for one revision of one App, read when the question opens. */
export function AppPublishData({
  app,
  revision,
  audienceLabel
}: {
  app: string;
  revision: number;
  /** Who the question's chosen audience names (SHARE-1), in place of who may use the App now. */
  audienceLabel?: string | undefined;
}) {
  return (
    <AppPublishDataView read={useAppPublishData(app, revision)} audienceLabel={audienceLabel} />
  );
}

/**
 * The lines for a given answer. Nothing where the revision reads no stored data: the question
 * then has nothing to say about it. Statements, parameters and rows are never shown; how many
 * rows the whole store held is said as what it is, the bound and not what the actions select.
 */
export function AppPublishDataView({
  read,
  audienceLabel,
  audiencePending = false
}: {
  read: AppPublishDataRead;
  /**
   * Who the audience chosen in the question names (SHARE-1). It takes the place of who may use
   * the App now: the lines say who would see the data after this publish.
   */
  audienceLabel?: string | undefined;
  /**
   * The answer for a newly chosen audience is on its way: who sees the data waits for it, and
   * the people of the choice before are never shown under the new one. The stores stay.
   */
  audiencePending?: boolean;
}) {
  const { t } = useTranslation();
  if (read.status === "loading") {
    return (
      <KeyValue label={t("apps.publishDataAudience")} data-field="data-audience">
        <SkeletonList rows={1} className="w-full" />
      </KeyValue>
    );
  }
  if (read.status === "failed") {
    return (
      <KeyValue label={t("apps.publishDataAudience")} data-field="data-audience">
        <div className="grid justify-items-start gap-2" data-testid="app-publish-data-failed">
          <InlineError>{t("apps.publishDataFailed")}</InlineError>
          <Button variant="outline" size="sm" onClick={read.retry}>
            {t("tryAgain")}
          </Button>
        </div>
      </KeyValue>
    );
  }
  const { data } = read;
  if (data.stores.length === 0) {
    return null;
  }
  const caption = "text-caption text-muted-foreground";
  return (
    <>
      <KeyValue label={t("apps.publishDataAudience")} data-field="data-audience">
        {audiencePending ? (
          <SkeletonList rows={1} className="w-full" data-testid="app-publish-audience-pending" />
        ) : (
          (audienceLabel ?? data.audience)
        )}
      </KeyValue>
      <KeyValue label={t("apps.publishDataStores")} data-field="data-stored">
        <div className="grid min-w-0 gap-3" data-testid="app-publish-data">
          <ul className="grid min-w-0 gap-3">
            {data.stores.map((store) => (
              <li key={store.name} className="grid min-w-0 gap-0.5" data-data-store={store.name}>
                <span className="font-medium text-foreground">{store.title}</span>
                <span className={caption}>{store.actions}</span>
                <span className={caption} data-data-store-rows="">
                  {store.rows}
                </span>
                {store.sources.map((source) => (
                  <span key={source} className={caption} data-data-store-source="">
                    {source}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <p className={caption}>{t("apps.publishDataNote")}</p>
          {data.truncated ? <p className={caption}>{t("dataStores.usedByTruncated")}</p> : null}
        </div>
      </KeyValue>
    </>
  );
}

/**
 * The line on an App's draft page that says how its stored data is read, for a draft with a
 * reading `sql` action: with the store's own app role, the store's rights checked for whoever
 * publishes and not for each viewer. Nothing for any other draft.
 */
export function AppStoredDataFact({ config }: { config: unknown }) {
  const { t } = useTranslation();
  return appReadsStoredData(config) ? (
    <Banner layout="page" className="shrink-0" data-testid="app-stored-data-fact">
      {t("apps.storedDataFact")}
    </Banner>
  ) : null;
}
