import { Badge, Chip, Page, PageHeader, Section } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { BuildAssetViewProps } from "./build-asset-kind";
import { DataStorePublishSection, migrationsOf, useDataStoreMenu } from "./data-store-head";

/** Whether the store is shown as a draft: it has a draft and nothing was published. */
export function dataStoreNeverPublished(
  asset: Pick<BuildAssetViewProps["asset"], "draftRevision" | "publishedRevision">
): boolean {
  return asset.draftRevision !== undefined && asset.publishedRevision === undefined;
}

/**
 * The page of a Data Store never published: there is no database yet, so nothing of its state,
 * its tables or its rows can be read. It says so, lists the migrations a publish applies with
 * their SQL, and offers Publish to whoever may publish it (Platform Access check 44).
 */
export function DataStoreDraftPage({
  page,
  back,
  asset,
  title,
  description,
  publish,
  remove,
  agentAction
}: BuildAssetViewProps & { title: string; description: string | undefined }) {
  const { t } = useTranslation();
  const migrations = migrationsOf(asset.config);
  const head = useDataStoreMenu({ id: asset.name, title, published: false, remove });
  return (
    <Page
      ref={page.ref}
      header={
        <PageHeader
          variant="detail"
          back={back}
          title={title}
          description={description}
          scope={
            <Chip>
              {t(
                asset.scope.kind === "workspace"
                  ? "dataStores.scopeWorkspace"
                  : "dataStores.scopeInstance"
              )}
            </Chip>
          }
          state={
            <Badge tone="warning" data-data-store-draft="">
              {t("dataStores.draftUnpublished")}
            </Badge>
          }
          primaryAction={agentAction}
          menu={head.menu}
        />
      }
    >
      {page.above}
      <div className="grid min-w-0 content-start gap-4 pt-5">
        {head.failure}
        <Section
          id="migrations"
          layout="stacked"
          title={t("dataStores.draftMigrationsTitle")}
          description={t("dataStores.draftMigrationsDescription")}
          count={migrations.length}
        >
          {description === undefined ? null : <p className="text-body">{description}</p>}
          <DataStorePublishSection
            title={title}
            migrations={migrations}
            firstPublish
            publish={publish}
          />
        </Section>
      </div>
      {head.dialog}
    </Page>
  );
}
