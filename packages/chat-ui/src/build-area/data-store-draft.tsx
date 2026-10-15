import { Send } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Chip,
  EmptyState,
  InlineError,
  List,
  ListRow,
  Page,
  PageHeader,
  Section
} from "@work-shape/catalyst-ui";
import { CopyIdMenu } from "../copy-id-item";
import { useTranslation } from "../i18n";
import type { BuildAssetViewProps } from "./build-asset-kind";
import { migrationNumber } from "./data-store-model";

/** One migration of a revision, as its definition lists it. */
interface DraftMigration {
  number: number;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The migrations a definition names, in the order they are applied. */
function draftMigrationsOf(config: Record<string, unknown>): DraftMigration[] {
  const listed = Array.isArray(config.migrations) ? config.migrations : [];
  return listed.flatMap((migration) =>
    isRecord(migration) &&
    typeof migration.number === "number" &&
    typeof migration.name === "string"
      ? [{ number: migration.number, name: migration.name }]
      : []
  );
}

/** The file a migration was saved as, as the agent wrote it: `0001_init.sql`. */
function migrationFileName(migration: DraftMigration): string {
  return `${migrationNumber(migration.number)}_${migration.name}.sql`;
}

/** Whether the store is shown as a draft: it has a draft and nothing was published. */
export function dataStoreNeverPublished(
  asset: Pick<BuildAssetViewProps["asset"], "draftRevision" | "publishedRevision">
): boolean {
  return asset.draftRevision !== undefined && asset.publishedRevision === undefined;
}

/**
 * The page of a Data Store never published: there is no database yet, so nothing of its state,
 * its tables or its rows can be read. It says so, lists the migrations a publish applies, and
 * offers Publish to whoever may publish it (Platform Access check 44). The agent never publishes.
 */
export function DataStoreDraftPage({
  page,
  back,
  asset,
  title,
  description,
  publish
}: BuildAssetViewProps & { title: string; description: string | undefined }) {
  const { t } = useTranslation();
  const [publishing, setPublishing] = useState(false);
  const [failure, setFailure] = useState<string>();
  const migrations = draftMigrationsOf(asset.config);
  const onPublish =
    publish === undefined
      ? undefined
      : async () => {
          setPublishing(true);
          setFailure(await publish());
          setPublishing(false);
        };
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
          overflow={<CopyIdMenu id={asset.name} label={t("build.assetActions")} />}
        />
      }
    >
      {page.above}
      <div className="grid min-w-0 content-start gap-4 pt-5">
        <Banner
          tone="info"
          title={t("dataStores.draftUnpublished")}
          action={
            onPublish === undefined ? undefined : (
              <Button
                size="sm"
                data-data-store-publish=""
                loading={publishing}
                onClick={() => {
                  onPublish().catch(() => undefined);
                }}
              >
                <Send aria-hidden="true" />
                {t("build.publish")}
              </Button>
            )
          }
        >
          {t("dataStores.draftUnpublishedText")}
        </Banner>
        {failure === undefined ? null : <InlineError>{failure}</InlineError>}
        <Section
          id="migrations"
          layout="stacked"
          title={t("dataStores.draftMigrationsTitle")}
          description={t("dataStores.draftMigrationsDescription")}
          count={migrations.length}
        >
          {description === undefined ? null : <p className="text-body">{description}</p>}
          {migrations.length === 0 ? (
            <EmptyState layout="inline">{t("dataStores.draftMigrationsEmpty")}</EmptyState>
          ) : (
            <List aria-label={t("dataStores.draftMigrationsTitle")}>
              {migrations.map((migration) => (
                <ListRow
                  key={migration.number}
                  data-data-store-draft-migration=""
                  title={
                    <code className="font-mono text-code">{migrationFileName(migration)}</code>
                  }
                />
              ))}
            </List>
          )}
        </Section>
      </div>
    </Page>
  );
}
