import { useMemo } from "react";
import {
  Badge,
  Chip,
  List,
  ListRow,
  Page,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";
import { useDockAgentWorksOn } from "../../chat/dock/dock-subject";
import { useTranslation } from "../../shared/i18n";
import type { BuildAssetViewProps } from "./build-asset-kind";
import { draftTablesOf, type DraftTable } from "./data-store-draft-fields";
import {
  DataStoreMigrations,
  DataStorePublishSection,
  migrationsOf,
  useDataStoreMenu
} from "./data-store-head";
import { columnTypeView } from "./data-store-model";

/** With this many tables or fewer, every table shows its fields without a click. */
const TABLES_OPEN_AT_MOST = 3;

/** Whether the store is shown as a draft: it has a draft and nothing was published. */
export function dataStoreNeverPublished(
  asset: Pick<BuildAssetViewProps["asset"], "draftRevision" | "publishedRevision">
): boolean {
  return asset.draftRevision !== undefined && asset.publishedRevision === undefined;
}

/** Whether a draft was saved after the last publish and waits to be published. */
export function dataStoreDraftAhead(
  asset: Pick<BuildAssetViewProps["asset"], "draftRevision" | "publishedRevision" | "revision">
): boolean {
  return asset.draftRevision !== undefined && asset.revision !== asset.publishedRevision;
}

/**
 * The page of a Data Store never published: there is no database yet, so nothing of its state,
 * its tables or its rows can be read. It says so, says in words what the store will hold as
 * its migrations define it, and offers Publish to whoever may publish it (Platform Access check
 * 44) once the agent in the dock is no longer writing it. The migrations' SQL stands folded
 * below, for whoever wants to read what runs.
 */
export function DataStoreDraftPage({
  page,
  back,
  asset,
  title,
  description,
  publish,
  remove
}: BuildAssetViewProps & { title: string; description: string | undefined }) {
  const { t } = useTranslation();
  const migrations = useMemo(() => migrationsOf(asset.config), [asset.config]);
  const tables = useMemo(() => draftTablesOf(migrations), [migrations]);
  const agentWorking = useDockAgentWorksOn("data_store", asset.name);
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
          menu={head.menu}
        />
      }
    >
      {page.above}
      <div className="grid min-w-0 content-start gap-6 pt-5">
        {head.failure}
        {description === undefined ? null : <p className="text-body">{description}</p>}
        <DataStorePublishSection
          title={title}
          migrations={migrations}
          firstPublish
          publish={publish}
          agentWorking={agentWorking}
          migrationsShown={false}
        />
        {tables.length === 0 ? null : (
          <Section
            id="fields"
            layout="stacked"
            title={t("dataStores.draftFieldsTitle")}
            description={t("dataStores.draftFieldsDescription")}
          >
            <DraftTables tables={tables} />
          </Section>
        )}
        <Section
          id="migrations"
          layout="stacked"
          title={t("dataStores.draftMigrationsTitle")}
          description={t("dataStores.draftMigrationsDescription")}
          count={migrations.length}
        >
          <DataStoreMigrations
            migrations={migrations}
            label={t("dataStores.draftMigrationsTitle")}
            emptyText={t("dataStores.draftMigrationsEmpty")}
            folded
          />
        </Section>
      </div>
      {head.dialog}
    </Page>
  );
}

/** The tables the draft defines. A table unfolds to its fields. */
function DraftTables({ tables }: { tables: readonly DraftTable[] }) {
  const { t } = useTranslation();
  return (
    <List aria-label={t("dataStores.draftFieldsTitle")}>
      {tables.map((table) => (
        <ListRow
          key={table.name}
          data-data-store-draft-table={table.name}
          expandable
          defaultExpanded={tables.length <= TABLES_OPEN_AT_MOST}
          title={<code className="font-mono text-code">{table.name}</code>}
          description={
            table.comment ??
            t(table.fields.length === 1 ? "dataStores.fieldCount" : "dataStores.fieldCounts", {
              count: table.fields.length
            })
          }
        >
          <DraftFields table={table} />
        </ListRow>
      ))}
    </List>
  );
}

/** Each field in words: its name, the kind of value it holds and whether it must be filled. */
function DraftFields({ table }: { table: DraftTable }) {
  const { t } = useTranslation();
  return (
    <Table density="compact" aria-label={t("dataStores.draftFieldsOf", { table: table.name })}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("dataStores.draftField")}</TableHead>
          <TableHead>{t("dataStores.draftFieldType")}</TableHead>
          <TableHead>{t("dataStores.draftFieldRequired")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.fields.map((field) => {
          // The type in words alone; the SQL name only where the product has no word for it.
          const { label, native } = columnTypeView({ type: field.type, nativeType: field.type });
          return (
            <TableRow key={field.name} data-data-store-draft-field={field.name}>
              <TableCell>
                <span className="flex min-w-0 items-center gap-2">
                  <code className="font-mono text-code">{field.name}</code>
                  {field.primaryKey ? (
                    <Badge size="sm">{t("dataStores.columnPrimaryKey")}</Badge>
                  ) : null}
                </span>
                {field.comment ? <TableCellDetail>{field.comment}</TableCellDetail> : null}
                {field.allowed ? (
                  <TableCellDetail>
                    {t("dataStores.draftFieldAllowed", { values: field.allowed.join(", ") })}
                  </TableCellDetail>
                ) : null}
              </TableCell>
              <TableCell>
                {label === undefined ? (
                  <code className="font-mono">{native ?? field.nativeType}</code>
                ) : label.list ? (
                  t("dataStores.typeList", { type: t(label.key) })
                ) : (
                  t(label.key)
                )}
              </TableCell>
              <TableCell>
                {t(field.nullable ? "dataStores.columnNullableNo" : "dataStores.columnNullableYes")}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
