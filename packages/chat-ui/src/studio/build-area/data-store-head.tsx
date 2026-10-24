import { Send, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  CodeBlock,
  ConfirmDialog,
  DropdownMenuItem,
  DropdownMenuSeparator,
  EmptyState,
  InlineError,
  List,
  ListRow
} from "@work-shape/catalyst-ui";
import { CopyIdItem } from "../copy-id-item";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { migrationNumber } from "./data-store-model";

// What the head and the publish of a Data Store's page share, before and after its first
// publish: the migrations a publish applies with their SQL, Publish with its question, and
// Delete with its question. Each write goes through the frame.

/** How many lines of a migration show before "Show more". */
const MIGRATION_LINES = 12;

/** One migration of a revision, as its definition lists it. */
export interface DataStoreMigration {
  number: number;
  name: string;
  /** The SQL it runs. Empty where the definition holds none. */
  sql: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The migrations a definition names, in the order they are applied. */
export function migrationsOf(config: Record<string, unknown>): DataStoreMigration[] {
  const listed = Array.isArray(config.migrations) ? config.migrations : [];
  return listed
    .flatMap((migration) =>
      isRecord(migration) &&
      typeof migration.number === "number" &&
      typeof migration.name === "string"
        ? [
            {
              number: migration.number,
              name: migration.name,
              sql: typeof migration.sql === "string" ? migration.sql : ""
            }
          ]
        : []
    )
    .sort((left, right) => left.number - right.number);
}

/** The migrations a publish of the draft applies: those past the published level. */
export function pendingMigrations(
  config: Record<string, unknown>,
  publishedLevel: number
): DataStoreMigration[] {
  return migrationsOf(config).filter((migration) => migration.number > publishedLevel);
}

/** The file a migration was saved as, as the agent wrote it: `0001_init.sql`. */
function migrationFileName(migration: DataStoreMigration): string {
  return `${migrationNumber(migration.number)}_${migration.name}.sql`;
}

/** The key of a sentence by how many migrations it counts: none, one or more. */
function byCount(
  count: number,
  keys: { none: TranslationKey; one: TranslationKey; many: TranslationKey }
): TranslationKey {
  return count === 0 ? keys.none : count === 1 ? keys.one : keys.many;
}

/**
 * Each migration by its file name, with the SQL it runs, so a publisher reads what runs. Folded,
 * the SQL waits behind the file name for whoever wants to read it.
 */
export function DataStoreMigrations({
  migrations,
  label,
  emptyText,
  folded = false
}: {
  migrations: readonly DataStoreMigration[];
  label: string;
  emptyText: string;
  folded?: boolean;
}) {
  if (migrations.length === 0) {
    return <EmptyState layout="inline">{emptyText}</EmptyState>;
  }
  return (
    <List aria-label={label}>
      {migrations.map((migration) => {
        const file = migrationFileName(migration);
        return (
          <ListRow
            key={migration.number}
            data-data-store-migration={migration.number}
            title={
              <code className="font-mono text-code" data-data-store-draft-migration="">
                {file}
              </code>
            }
            // Open, a publisher reads what runs without a click, and may fold it.
            expandable={migration.sql !== ""}
            defaultExpanded={!folded}
          >
            {migration.sql === "" ? null : (
              <CodeBlock
                data-data-store-migration-sql=""
                label={file}
                code={migration.sql}
                maxLines={MIGRATION_LINES}
              />
            )}
          </ListRow>
        );
      })}
    </List>
  );
}

/**
 * The draft's migrations and the way to publish them: a banner that says what waits, Publish
 * for whoever may, the migrations with their SQL, and the question before anything runs. A
 * migration applied to the database is not taken back, so the person confirms first, and the
 * agent never publishes.
 */
export function DataStorePublishSection({
  title,
  migrations,
  firstPublish,
  publish,
  agentWorking = false,
  migrationsShown = true
}: {
  /** The store's name people read, for the question. */
  title: string;
  /** What the publish applies, in order. */
  migrations: readonly DataStoreMigration[];
  /** Nothing is published yet: the publish also creates the database. */
  firstPublish: boolean;
  publish: (() => Promise<string | undefined>) | undefined;
  /**
   * The agent in the dock is still writing this draft: Publish waits until it is done, and the
   * banner says so.
   */
  agentWorking?: boolean;
  /** The migrations stand below the banner; the page of a draft shows them on their own. */
  migrationsShown?: boolean;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [failure, setFailure] = useState<string>();
  const count = migrations.length;
  const onPublish =
    publish === undefined || agentWorking
      ? undefined
      : async () => {
          setPublishing(true);
          setFailure(await publish());
          setPublishing(false);
          setConfirming(false);
        };
  return (
    <section className="grid min-w-0 gap-4" data-data-store-pending="">
      <Banner
        tone="info"
        title={t(firstPublish ? "dataStores.draftUnpublished" : "dataStores.draftAhead")}
        action={
          onPublish === undefined ? undefined : (
            <Button size="sm" data-data-store-publish="" onClick={() => setConfirming(true)}>
              <Send aria-hidden="true" />
              {t("build.publish")}
            </Button>
          )
        }
      >
        {firstPublish
          ? t("dataStores.draftUnpublishedText")
          : t(
              byCount(count, {
                none: "dataStores.draftAheadTextNone",
                one: "dataStores.draftAheadTextOne",
                many: "dataStores.draftAheadText"
              }),
              { count }
            )}
        {agentWorking ? (
          <span className="mt-1 block" data-data-store-agent-working="">
            {t("dataStores.draftAgentWorking")}
          </span>
        ) : null}
      </Banner>
      {failure === undefined ? null : <InlineError>{failure}</InlineError>}
      {migrationsShown ? (
        <DataStoreMigrations
          migrations={migrations}
          label={t(firstPublish ? "dataStores.draftMigrationsTitle" : "dataStores.pendingTitle")}
          emptyText={t(
            firstPublish ? "dataStores.draftMigrationsEmpty" : "dataStores.pendingEmpty"
          )}
        />
      ) : null}
      {onPublish === undefined ? null : (
        <ConfirmDialog
          open={confirming}
          tone="primary"
          title={t("build.publishTitle", { name: title })}
          confirmLabel={t("build.publish")}
          loading={publishing}
          onConfirm={() => {
            onPublish().catch(() => undefined);
          }}
          onClose={() => setConfirming(false)}
        >
          <span data-data-store-publish-confirm="">
            {firstPublish
              ? t(
                  count === 1
                    ? "dataStores.publishDescriptionOne"
                    : "dataStores.publishDescription",
                  { count }
                )
              : t(
                  byCount(count, {
                    none: "dataStores.publishPendingDescriptionNone",
                    one: "dataStores.publishPendingDescriptionOne",
                    many: "dataStores.publishPendingDescription"
                  }),
                  { count }
                )}
          </span>
        </ConfirmDialog>
      )}
    </section>
  );
}

/**
 * The "…" menu of a store's head: Copy ID, and Delete for whoever may, with the question that
 * names the store. The delete is the frame's, under the same rights and audit as every Build
 * delete. A store never published holds no rows; a published one keeps its rows on the server
 * and its name stays taken, as the question says.
 */
export function useDataStoreMenu({
  id,
  title,
  published,
  remove
}: {
  id: string;
  title: string;
  published: boolean;
  remove: (() => Promise<string | undefined>) | undefined;
}): { menu: ReactNode; dialog: ReactNode; failure: ReactNode } {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const onDelete =
    remove === undefined
      ? undefined
      : async () => {
          setDeleting(true);
          const refused = await remove();
          setDeleting(false);
          setOpen(false);
          setFailure(refused);
        };
  return {
    menu: (
      <>
        <CopyIdItem id={id} />
        {onDelete === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              tone="danger"
              icon={<Trash2 aria-hidden="true" />}
              onSelect={() => setOpen(true)}
            >
              {t("configDelete")}
            </DropdownMenuItem>
          </>
        )}
      </>
    ),
    dialog:
      onDelete === undefined ? null : (
        <ConfirmDialog
          open={open}
          title={t("dataStores.deleteTitle", { name: title })}
          confirmLabel={t("configDelete")}
          loading={deleting}
          onConfirm={() => {
            onDelete().catch(() => undefined);
          }}
          onClose={() => setOpen(false)}
        >
          <span data-data-store-delete-confirm="">
            {t(published ? "dataStores.deleteDescription" : "dataStores.deleteDescriptionDraft")}
          </span>
        </ConfirmDialog>
      ),
    failure:
      failure === undefined ? null : (
        <InlineError data-data-store-delete-failed="">{failure}</InlineError>
      )
  };
}
