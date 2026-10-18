import { Database } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Checkbox,
  EmptyState,
  Field,
  Input,
  KeyValue,
  KeyValueList,
  Picker,
  PickerButton,
  RadioGroup,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { AssetEditorShell, useAssetForm, type AssetSection } from "./asset-editor-shell";
import { FieldRefusals } from "./asset-form-fields";
import { countChangedFields } from "./asset-form-model";
import type { BuildAssetEditorProps } from "./build-asset-kind";
import { refusalsOf } from "./build-refusals";
import { DataFlowList, useWorkflowPage } from "./data-flows";
import { hasDataFlows, type DataFlowRole } from "./data-flows-model";
import { ReadState } from "./data-store-read-state";
import { KnowledgeStatus, KnowledgeTestQuery } from "./knowledge-base-checks";
import { KnowledgeDocuments } from "./knowledge-base-documents";
import { KnowledgeTestSearch } from "./knowledge-base-test-search";
import {
  knowledgeBaseFormToConfig,
  knowledgeTableRows,
  type KnowledgeBaseForm,
  type KnowledgeBaseHolds,
  type KnowledgeTableForm
} from "./knowledge-base-model";
import type { KnowledgeBaseSource } from "./knowledge-base-source";

/** The sections of the data Workflows on the page, by what they do to it. */
const FLOW_SECTIONS = {
  fills: {
    id: "filled-by",
    label: "knowledge.filledByTitle",
    description: "knowledge.filledByDescription"
  },
  processes: {
    id: "processed-by",
    label: "knowledge.processedByTitle",
    description: "knowledge.processedByDescription"
  }
} as const satisfies Record<
  DataFlowRole,
  { id: string; label: TranslationKey; description: TranslationKey }
>;

/**
 * The page of one Knowledge Base: what it holds and what it answers from. A new one is chosen
 * to answer from documents or from tables of a Data Store; that stays once it is created. With
 * documents, the published Knowledge Base lists them with their state, takes more and has a
 * search to try; with tables, it names the Data Store with a sentence per table, and once
 * published whether it can read them and a query to try. The frame saves the form as a draft and publishes it.
 */
export function KnowledgeBaseEditor({
  frame,
  initialForm,
  source
}: {
  frame: BuildAssetEditorProps;
  initialForm: KnowledgeBaseForm;
  source: KnowledgeBaseSource;
}) {
  const { t } = useTranslation();
  const state = useAssetForm(initialForm);
  const { form, setForm, outcome } = state;
  const [saving, setSaving] = useState(false);
  const { canWrite, asset } = frame;
  const update = (patch: Partial<KnowledgeBaseForm>) =>
    setForm((value) => ({ ...value, ...patch }));
  const submit = async () => {
    setSaving(true);
    const answer = await frame.save(knowledgeBaseFormToConfig(form));
    setSaving(false);
    state.setOutcome(answer);
    if (answer.ok) {
      state.markSaved();
    }
    return answer;
  };
  const published = asset?.publishedRevision;
  const documents = form.holds === "documents";
  // The data Workflows that fill or process it arrive with the state the Status section reads:
  // the same read, not another. A section stands only where one is named or counted.
  const stateRead = source.useState(asset?.name ?? "", published);
  const dataFlows = stateRead.status === "ready" ? stateRead.data.dataFlows : undefined;
  const workflowPage = useWorkflowPage();
  const namedRoles = (["fills", "processes"] as const).filter((role) =>
    hasDataFlows(dataFlows, role)
  );
  // A cut read that found none still says the list may be incomplete, under Filled by.
  const flowRoles: readonly DataFlowRole[] =
    namedRoles.length === 0 && dataFlows?.truncated === true ? ["fills"] : namedRoles;
  const flowSections: AssetSection[] =
    dataFlows === undefined
      ? []
      : flowRoles.map((role, index) => {
          const view = FLOW_SECTIONS[role];
          return {
            id: view.id,
            label: t(view.label),
            description: t(view.description),
            count: dataFlows[role].length,
            body: (
              <DataFlowList
                flows={dataFlows}
                role={role}
                pageOf={workflowPage}
                label={t(view.label)}
                // The note on a cut read stands once, under the last of the sections.
                showTruncated={index === flowRoles.length - 1}
              />
            )
          };
        });
  const holdsOptions: { value: KnowledgeBaseHolds; label: string; description: string }[] = [
    {
      value: "documents",
      label: t("knowledge.holdsDocuments"),
      description: t("knowledge.holdsDocumentsDescription")
    },
    {
      value: "tables",
      label: t("knowledge.holdsTables"),
      description: t("knowledge.holdsTablesDescription")
    }
  ];

  const sections: AssetSection[] = [
    {
      id: "about",
      label: t("knowledge.aboutTitle"),
      description: t("knowledge.aboutDescription"),
      body: (
        <>
          <Field label={t("knowledge.titleLabel")} required>
            <Input
              value={form.title}
              required
              readOnly={!canWrite}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <Field
            label={t("knowledge.descriptionLabel")}
            hint={t(
              form.holds === "documents"
                ? "knowledge.descriptionHintDocuments"
                : "knowledge.descriptionHint"
            )}
            required
          >
            <Textarea
              value={form.description}
              required
              rows={3}
              readOnly={!canWrite}
              onChange={(event) => update({ description: event.target.value })}
            />
          </Field>
        </>
      )
    },
    {
      id: "source",
      label: t("knowledge.sourceTitle"),
      description: t(
        documents ? "knowledge.sourceDocumentsDescription" : "knowledge.sourceDescription"
      ),
      ...(documents ? {} : { count: form.tables.length }),
      refusalField: "source",
      body: (
        <>
          {asset ? (
            <KeyValueList layout="stacked">
              <KeyValue label={t("knowledge.holdsLabel")}>
                {t(documents ? "knowledge.holdsDocuments" : "knowledge.holdsTables")}
              </KeyValue>
            </KeyValueList>
          ) : (
            <RadioGroup
              label={t("knowledge.holdsLabel")}
              options={holdsOptions}
              value={form.holds}
              disabled={!canWrite}
              onValueChange={(holds) => update({ holds })}
            />
          )}
          {documents ? null : (
            <TablesSource source={source} form={form} canWrite={canWrite} update={update} />
          )}
          <FieldRefusals messages={refusalsOf(outcome, "source")} />
        </>
      )
    },
    ...flowSections,
    ...(documents
      ? [
          {
            id: "documents",
            label: t("knowledge.documentsTitle"),
            description: t("knowledge.documentsDescription"),
            body:
              asset && published !== undefined ? (
                <KnowledgeDocuments
                  source={source}
                  knowledgeBase={asset.name}
                  publishedRevision={published}
                  canWrite={canWrite}
                />
              ) : (
                <EmptyState layout="inline">{t("knowledge.notPublishedDocuments")}</EmptyState>
              )
          }
        ]
      : []),
    {
      id: "status",
      label: t("knowledge.statusTitle"),
      description: t(
        documents ? "knowledge.statusDocumentsDescription" : "knowledge.statusDescription"
      ),
      body:
        asset && published !== undefined ? (
          <KnowledgeStatus
            source={source}
            knowledgeBase={asset.name}
            publishedRevision={published}
            canCheck={canWrite}
          />
        ) : (
          <EmptyState layout="inline">
            {t(documents ? "knowledge.notPublishedDocuments" : "knowledge.notPublished")}
          </EmptyState>
        )
    },
    ...(documents
      ? [
          {
            id: "test",
            label: t("knowledge.searchTitle"),
            description: t("knowledge.searchDescription"),
            body:
              asset && published !== undefined ? (
                <KnowledgeTestSearch source={source} knowledgeBase={asset.name} />
              ) : (
                <EmptyState layout="inline">{t("knowledge.notPublishedSearch")}</EmptyState>
              )
          }
        ]
      : [
          {
            id: "test",
            label: t("knowledge.testTitle"),
            description: t("knowledge.testDescription"),
            body:
              asset && published !== undefined ? (
                <KnowledgeTestQuery
                  source={source}
                  knowledgeBase={asset.name}
                  firstTable={form.tables[0]?.name}
                />
              ) : (
                <EmptyState layout="inline">{t("knowledge.notPublished")}</EmptyState>
              )
          }
        ])
  ];

  return (
    <AssetEditorShell
      frame={frame}
      title={form.title.trim() || form.name}
      description={form.description.trim()}
      sections={sections}
      control={{
        changes: countChangedFields(form, state.baseline),
        submit,
        discard: state.discard
      }}
      outcome={outcome}
      saving={saving}
      saveLabel={asset ? t("configSaveChanges") : t("knowledge.create")}
      saveHint={t("build.savesDraft")}
    />
  );
}

/** The Data Store a Knowledge Base of tables reads, and the tables of it that it describes. */
function TablesSource({
  source,
  form,
  canWrite,
  update
}: {
  source: KnowledgeBaseSource;
  form: KnowledgeBaseForm;
  canWrite: boolean;
  update(patch: Partial<KnowledgeBaseForm>): void;
}) {
  return (
    <>
      <DataStoreChoice
        source={source}
        value={form.dataStore}
        disabled={!canWrite}
        // Another store has other tables: what was described of the first one goes.
        onChange={(dataStore) =>
          update({ dataStore, tables: dataStore === form.dataStore ? form.tables : [] })
        }
      />
      <TableChoice
        source={source}
        store={form.dataStore || undefined}
        tables={form.tables}
        disabled={!canWrite}
        onChange={(tables) => update({ tables })}
      />
    </>
  );
}

/** The Data Store the Knowledge Base reads, chosen from those the reader may read. */
function DataStoreChoice({
  source,
  value,
  disabled,
  onChange
}: {
  source: KnowledgeBaseSource;
  value: string;
  disabled: boolean;
  onChange(dataStore: string): void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const read = source.useDataStores(search);
  const stores = read.status === "ready" ? read.data : [];
  const chosen = stores.find((store) => store.name === value);
  const error =
    read.status === "failed" || read.status === "refused"
      ? t("knowledge.dataStoresFailed")
      : read.status === "ready" && stores.length === 0 && search === "" && value === ""
        ? t("knowledge.noDataStores")
        : undefined;
  return (
    <Field label={t("knowledge.dataStore")} required error={error}>
      <Picker
        search
        label={t("knowledge.chooseDataStore")}
        onSearchChange={(text) => setSearch(text.trim())}
        options={stores.map((store) => ({
          value: store.name,
          label: store.title || store.name,
          description: store.description,
          keywords: store.name,
          leading: <Database aria-hidden="true" />
        }))}
        value={value || undefined}
        onValueChange={onChange}
      >
        <PickerButton
          label={t("knowledge.dataStore")}
          placeholder={t("knowledge.chooseDataStore")}
          value={chosen?.title || value || undefined}
          leading={value ? <Database aria-hidden="true" /> : undefined}
          disabled={disabled}
        />
      </Picker>
    </Field>
  );
}

/**
 * The tables of the chosen store, each with a box that lets agents answer from it and the
 * sentence they read about a row. A described table the store does not have stays listed, with
 * that said, until the box is cleared.
 */
function TableChoice({
  source,
  store,
  tables,
  disabled,
  onChange
}: {
  source: KnowledgeBaseSource;
  store: string | undefined;
  tables: readonly KnowledgeTableForm[];
  disabled: boolean;
  onChange(tables: KnowledgeTableForm[]): void;
}) {
  const { t } = useTranslation();
  const read = source.useStoreTables(store);
  if (store === undefined) {
    return <EmptyState layout="inline">{t("knowledge.chooseStoreFirst")}</EmptyState>;
  }
  const toggle = (name: string, on: boolean) =>
    onChange(
      on ? [...tables, { name, description: "" }] : tables.filter((table) => table.name !== name)
    );
  const describe = (name: string, description: string) =>
    onChange(tables.map((table) => (table.name === name ? { ...table, description } : table)));
  return (
    // Not `required`: a Field hands that to each box in it, and a box left clear is no error.
    <Field label={t("knowledge.tables")} hint={t("knowledge.tablesHint")}>
      <ReadState
        read={read}
        failedText={t("knowledge.tablesFailed")}
        refusedText={t("knowledge.tablesFailed")}
        rows={3}
      >
        {(storeTables) => {
          const rows = knowledgeTableRows(storeTables, tables);
          return rows.length === 0 ? (
            <EmptyState layout="inline">{t("knowledge.tablesEmpty")}</EmptyState>
          ) : (
            <ul aria-label={t("knowledge.tables")} className="grid gap-3" data-knowledge-tables="">
              {rows.map((row) => (
                <li key={row.name} className="grid gap-2" data-knowledge-table={row.name}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Checkbox
                      label={<code className="font-mono text-code">{row.name}</code>}
                      checked={row.described !== undefined}
                      disabled={disabled}
                      onCheckedChange={(on) => toggle(row.name, on)}
                    />
                    {row.inStore ? null : (
                      <Badge tone="warning">{t("knowledge.tableMissing")}</Badge>
                    )}
                  </div>
                  {row.described ? (
                    <Input
                      aria-label={t("knowledge.tableDescription", { table: row.name })}
                      placeholder={t("knowledge.tableDescription", { table: row.name })}
                      value={row.described.description}
                      required
                      readOnly={disabled}
                      onChange={(event) => describe(row.name, event.target.value)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          );
        }}
      </ReadState>
    </Field>
  );
}
