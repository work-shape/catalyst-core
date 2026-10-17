import { BookOpen, Database, LayoutGrid, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Chip, EmptyState, List, ListRow } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { ReadState } from "./data-store-read-state";
import {
  audienceLine,
  dataStoreFillers,
  fillerLine,
  runsAsLine
} from "./data-store-provenance-model";
import type { DataStoreSource, DataStoreUsedBy } from "./data-store-source";

// The two sections of a store's page on where its rows come from and who reads them. Both are
// one answer of the instance, read from the published definitions whatever state the store is
// in. A row is a link where the interface has a page for what it names. Of what the reader may
// not see, the instance tells a number, in the section where it would stand.

type UsingKind = "app" | "workflow" | "knowledge_base";

const KINDS: Record<UsingKind, { icon: typeof Workflow; label: TranslationKey }> = {
  app: { icon: LayoutGrid, label: "dataStores.usedByApp" },
  workflow: { icon: Workflow, label: "dataStores.usedByWorkflow" },
  knowledge_base: { icon: BookOpen, label: "dataStores.usedByKnowledgeBase" }
};

interface ProvenanceProps {
  store: string;
  /** The workspace the store belongs to, where it belongs to one. */
  workspaceId: string | undefined;
  source: DataStoreSource;
}

/** "Filled by": each published Workflow and App that adds rows, with where they come from. */
export function DataStoreFillers({ store, workspaceId, source }: ProvenanceProps) {
  const { locale, t } = useTranslation();
  const row = useUsingRow(workspaceId, source);
  return (
    <UsedByRead store={store} source={source}>
      {(used) => {
        const fillers = dataStoreFillers(used);
        const hidden = used.hidden.fills;
        if (fillers.length === 0) {
          // Nothing is said to fill the store while something the reader may not see does.
          return (
            <EmptyState layout="inline">
              {hidden === 0
                ? t("dataStores.filledByEmpty")
                : hidden === 1
                  ? t("dataStores.filledByHiddenOnlyOne")
                  : t("dataStores.filledByHiddenOnly", { count: formatCount(hidden, locale) })}
            </EmptyState>
          );
        }
        return (
          <>
            <List aria-label={t("dataStores.filledByTitle")}>
              {fillers.map((filler) =>
                row({
                  kind: filler.kind,
                  name: filler.name,
                  title: filler.title,
                  description: fillerLine(filler, t, locale),
                  role: "filled-by"
                })
              )}
            </List>
            <HiddenLine count={hidden} />
          </>
        );
      }}
    </UsedByRead>
  );
}

/**
 * "Read by": each published App and Knowledge Base on the store with who it reaches, each
 * Workflow that reads it without filling it, and who may read the store itself.
 */
export function DataStoreReaders({ store, workspaceId, source }: ProvenanceProps) {
  const { locale, t } = useTranslation();
  const row = useUsingRow(workspaceId, source);
  return (
    <UsedByRead store={store} source={source}>
      {(used) => {
        return (
          <>
            <List aria-label={t("dataStores.readByTitle")}>
              {used.apps
                .filter((app) => app.reads)
                .map((app) =>
                  row({
                    kind: "app",
                    name: app.name,
                    title: app.title,
                    description: audienceLine(app.audience, t, locale),
                    role: "read-by"
                  })
                )}
              {used.knowledgeBases.map((knowledgeBase) =>
                row({
                  kind: "knowledge_base",
                  name: knowledgeBase.name,
                  title: knowledgeBase.title,
                  description: audienceLine(knowledgeBase.audience, t, locale),
                  role: "read-by"
                })
              )}
              {used.workflows
                .filter((workflow) => workflow.reads && !workflow.writes)
                .map((workflow) =>
                  row({
                    kind: "workflow",
                    name: workflow.name,
                    title: workflow.title,
                    description: workflow.account ? runsAsLine(workflow.account, t) : undefined,
                    role: "read-by"
                  })
                )}
              <ListRow
                data-data-store-readers=""
                leading={<Database aria-hidden="true" className="size-4 text-muted-foreground" />}
                title={t("dataStores.readersStore")}
                description={audienceLine(used.readers, t, locale)}
                descriptionWraps
              />
            </List>
            <HiddenLine count={used.hidden.reads} />
            <p className="text-caption text-muted-foreground" data-data-store-admins="">
              {t("dataStores.readByAdmins")}
            </p>
            {used.truncated ? (
              <p className="text-caption text-muted-foreground">
                {t("dataStores.usedByTruncated")}
              </p>
            ) : null}
          </>
        );
      }}
    </UsedByRead>
  );
}

function formatCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(count);
}

/** How many more stand in a section that the reader may not see, where there are any. */
function HiddenLine({ count }: { count: number }) {
  const { locale, t } = useTranslation();
  return count > 0 ? (
    <p className="text-caption text-muted-foreground" data-data-store-used-by-hidden="">
      {t("dataStores.usedByHidden", { count: formatCount(count, locale) })}
    </p>
  ) : null;
}

function UsedByRead({
  store,
  source,
  children
}: {
  store: string;
  source: DataStoreSource;
  children(used: DataStoreUsedBy): ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ReadState
      read={source.useUsedBy(store)}
      failedText={t("dataStores.usedByFailed")}
      refusedText={t("dataStores.usedByRefused")}
      rows={2}
    >
      {(used) => children(used)}
    </ReadState>
  );
}

/** One row of what uses the store: its kind, its name, a line on it, and its page where it has one. */
function useUsingRow(workspaceId: string | undefined, source: DataStoreSource) {
  const { t } = useTranslation();
  const pageOf = source.useUsingPage(workspaceId);
  return ({
    kind,
    name,
    title,
    description,
    role
  }: {
    kind: UsingKind;
    name: string;
    title: string;
    description: string | undefined;
    role: "filled-by" | "read-by";
  }) => {
    const page = kind === "knowledge_base" ? undefined : pageOf(kind, name);
    const { icon: Icon, label } = KINDS[kind];
    return (
      <ListRow
        key={`${kind}:${name}`}
        data-data-store-used-by={kind}
        data-data-store-role={role}
        leading={<Icon aria-hidden="true" className="size-4 text-muted-foreground" />}
        title={title.trim() || name}
        description={description}
        // Who reads and where rows come from is read whole on a phone too.
        descriptionWraps
        chips={<Chip size="sm">{t(label)}</Chip>}
        link={
          page === undefined ? undefined : (
            <a
              href={page.href}
              onClick={(event) => {
                // A plain press opens the page here. Any other opens the address.
                if (
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  page.open();
                }
              }}
            />
          )
        }
      />
    );
  };
}
