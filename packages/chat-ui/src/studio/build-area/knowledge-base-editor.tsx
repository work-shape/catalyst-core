import { Database } from "lucide-react";
import { useState } from "react";
import { KNOWLEDGE_DOCUMENT_FORMATS } from "@work-shape/catalyst-core";
import {
  Badge,
  Banner,
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
import { useOptionalSettingsPage } from "../../shared/settings-page-context";
import { AssetEditorShell, useAssetForm, type AssetSection } from "./asset-editor-shell";
import {
  AvailabilityFields,
  useAvailabilityEdit,
  type AvailabilityChoice
} from "./asset-availability-fields";
import { FieldRefusals } from "./asset-form-fields";
import { countChangedFields } from "./asset-form-model";
import type { BuildAssetEditorProps } from "./build-asset-kind";
import { refusalsOf, type BuildWriteOutcome } from "./build-refusals";
import { DataFlowList, useWorkflowPage } from "./data-flows";
import { hasDataFlows, type DataFlowRole } from "./data-flows-model";
import { ReadState } from "./data-store-read-state";
import { KnowledgeBaseAgents, KnowledgeBaseHolders } from "./knowledge-base-access";
import { KnowledgeStatus, KnowledgeTestQuery } from "./knowledge-base-checks";
import { KnowledgeDocuments } from "./knowledge-base-documents";
import { KnowledgeSourcesSection } from "./knowledge-base-sources";
import { KnowledgeTestSearch } from "./knowledge-base-test-search";
import {
  knowledgeBaseFormToConfig,
  knowledgeBasePublishesOnCreate,
  knowledgeTableRows,
  type KnowledgeBaseForm,
  type KnowledgeBaseHolds,
  type KnowledgeTableForm
} from "./knowledge-base-model";
import type { KnowledgeBaseSource, KnowledgeHoldersRead } from "./knowledge-base-source";
import { uploadFormatList, uploadFormats } from "./knowledge-upload-model";

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
 * to answer from documents or from tables of a Data Store; that stays once it is created. One of
 * documents goes live on create, available nowhere, so files can be added at once (KB-PAGE-1).
 * With documents, the published Knowledge Base lists them with their state, takes more and has
 * a search to try; with tables, it names the Data Store with a sentence per table, and once
 * published whether it can read them and a query to try. Before its first publish, one notice
 * under the head says what publishing opens, in place of those sections. The frame saves the
 * form as a draft and publishes it.
 * Where it is available applies at once, saved with the same save bar.
 */
export function KnowledgeBaseEditor({
  frame,
  initialForm,
  source,
  availability
}: {
  frame: BuildAssetEditorProps;
  initialForm: KnowledgeBaseForm;
  source: KnowledgeBaseSource;
  /** Where agents can use it, for a reader who may change it. */
  availability?: AvailabilityChoice;
}) {
  const { locale, t } = useTranslation();
  const settings = useOptionalSettingsPage();
  const state = useAssetForm(initialForm);
  const { form, setForm, outcome } = state;
  const [saving, setSaving] = useState(false);
  const { canWrite, asset } = frame;
  const update = (patch: Partial<KnowledgeBaseForm>) =>
    setForm((value) => ({ ...value, ...patch }));
  const availabilityEdit = useAvailabilityEdit(availability);
  const changedFields = countChangedFields(form, state.baseline);
  // The definition first, then where it is available, each only when it changed.
  const submit = async (): Promise<BuildWriteOutcome> => {
    setSaving(true);
    const saved: BuildWriteOutcome =
      asset === undefined || changedFields > 0
        ? await frame.save(knowledgeBaseFormToConfig(form))
        : { ok: true };
    if (saved.ok) {
      state.markSaved();
    }
    const refused =
      saved.ok && availabilityEdit.changed ? await availabilityEdit.save() : undefined;
    const answer: BuildWriteOutcome =
      refused === undefined
        ? saved
        : { ok: false, conflict: false, refusals: [{ field: "availability", message: refused }] };
    setSaving(false);
    state.setOutcome(answer);
    return answer;
  };
  const published = asset?.publishedRevision;
  const documents = form.holds === "documents";
  // What only a published Knowledge Base has: its documents, its status and a test.
  const live = asset !== undefined && published !== undefined;
  // The Connector types of the instance its documents can be synced from, named under Source.
  // The data Workflows that fill or process it arrive with the state the Status section reads:
  // the same read, not another. A section stands only where one is named or counted.
  const stateRead = source.useState(asset?.name ?? "", published);
  const dataFlows = stateRead.status === "ready" ? stateRead.data.dataFlows : undefined;
  // The agents that search it come with the same read, from an instance that names them.
  const agents = stateRead.status === "ready" ? stateRead.data.agents : undefined;
  const workflowPage = useWorkflowPage();
  const holders: KnowledgeHoldersRead = source.useHolders?.(asset?.id) ?? { status: "hidden" };
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
  // Whether the published version can keep and search its documents, or read its tables.
  const statusSection = (knowledgeBase: string, publishedRevision: number): AssetSection => ({
    id: "status",
    label: t("knowledge.statusTitle"),
    description: t(
      documents ? "knowledge.statusDocumentsDescription" : "knowledge.statusDescription"
    ),
    body: (
      <KnowledgeStatus
        source={source}
        knowledgeBase={knowledgeBase}
        publishedRevision={publishedRevision}
        canCheck={canWrite}
      />
    )
  });
  const holdsOptions: { value: KnowledgeBaseHolds; label: string; description: string }[] = [
    {
      value: "documents",
      label: t("knowledge.holdsDocuments"),
      // The formats this instance reads: PDF and DOCX need its document processing, the same
      // module switch the instance reads them by. Without the settings, the text formats.
      description: t("knowledge.holdsDocumentsDescription", {
        formats: uploadFormatList(
          uploadFormats(
            settings?.config.modules.documents?.enabled === true
              ? KNOWLEDGE_DOCUMENT_FORMATS
              : undefined
          ),
          locale
        )
      })
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
            <TablesSource
              source={source}
              owner={frame.owner}
              form={form}
              canWrite={canWrite}
              update={update}
            />
          )}
          <FieldRefusals messages={refusalsOf(outcome, "source")} />
        </>
      )
    },
    ...(documents && source.useSourceConnections
      ? [
          {
            id: "sources",
            label: t("knowledgeSources.title"),
            description: t("knowledgeSources.description"),
            count: form.sources.length,
            refusalField: "sources" as const,
            body: (
              <>
                <KnowledgeSourcesSection
                  source={source}
                  knowledgeBase={asset?.name}
                  published={published}
                  owner={frame.owner}
                  sources={form.sources}
                  canWrite={canWrite}
                  onChange={(sources) => update({ sources })}
                />
                <FieldRefusals messages={refusalsOf(outcome, "sources")} />
              </>
            )
          }
        ]
      : []),
    ...flowSections,
    // Before its first publish these stand as one notice under the head, not as empty sections.
    ...(!live
      ? []
      : documents
        ? [
            {
              id: "documents",
              label: t("knowledge.documentsTitle"),
              description: t("knowledge.documentsDescription"),
              body: (
                <KnowledgeDocuments
                  source={source}
                  knowledgeBase={asset.name}
                  publishedRevision={published}
                  canWrite={canWrite}
                />
              )
            },
            statusSection(asset.name, published),
            {
              id: "test",
              label: t("knowledge.searchTitle"),
              description: t("knowledge.searchDescription"),
              body: <KnowledgeTestSearch source={source} knowledgeBase={asset.name} />
            }
          ]
        : [
            statusSection(asset.name, published),
            {
              id: "test",
              label: t("knowledge.testTitle"),
              description: t("knowledge.testDescription"),
              body: (
                <KnowledgeTestQuery
                  source={source}
                  knowledgeBase={asset.name}
                  firstTable={form.tables[0]?.name}
                />
              )
            }
          ]),
    ...(availability
      ? [
          {
            id: "availability",
            label: t("configAvailability"),
            description: t("configAvailabilityKnowledgeBaseDescription"),
            refusalField: "availability" as const,
            body: (
              <AvailabilityFields
                edit={availabilityEdit}
                disabled={saving}
                workspaces={availability.workspaces}
                workspacesError={availability.workspacesError}
                hiddenHint={t("configAvailabilityAssetHiddenHint")}
                refusals={refusalsOf(outcome, "availability")}
              />
            )
          }
        ]
      : []),
    ...(agents === undefined || stateRead.status !== "ready"
      ? []
      : [
          {
            id: "agents",
            label: t("knowledge.agentsTitle"),
            description: t("knowledge.agentsDescription"),
            count: agents.length,
            body: (
              <KnowledgeBaseAgents
                agents={agents}
                truncated={stateRead.data.agentsTruncated === true}
              />
            )
          }
        ]),
    // Who was given it by itself is shown to who is shown rights at all, as on a Connection.
    ...(holders.status === "hidden"
      ? []
      : [
          {
            id: "access",
            label: t("knowledge.accessTitle"),
            description: t("knowledge.accessDescription"),
            count: holders.status === "ready" ? holders.holders.length : undefined,
            body: <KnowledgeBaseHolders read={holders} />
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
        changes: changedFields + (availabilityEdit.changed ? 1 : 0),
        submit,
        discard: () => {
          state.discard();
          availabilityEdit.discard();
        }
      }}
      notices={
        asset !== undefined && published === undefined ? (
          <Banner tone="info" className="mb-3" data-knowledge-not-published="">
            {t(documents ? "knowledge.notPublishedDocuments" : "knowledge.notPublished")}
          </Banner>
        ) : undefined
      }
      outcome={outcome}
      saving={saving}
      saveLabel={asset ? t("configSaveChanges") : t("knowledge.create")}
      // Where it is available applies at once; only its definition goes to the draft. A new one
      // of documents goes live on create.
      {...(asset === undefined && knowledgeBasePublishesOnCreate(knowledgeBaseFormToConfig(form))
        ? { saveHint: t("knowledge.createsLive") }
        : asset === undefined || changedFields > 0
          ? { saveHint: t("build.savesDraft") }
          : {})}
    />
  );
}

/** The Data Store a Knowledge Base of tables reads, and the tables of it that it describes. */
function TablesSource({
  source,
  owner,
  form,
  canWrite,
  update
}: {
  source: KnowledgeBaseSource;
  /** The workspace that owns the Knowledge Base, absent for one of the instance. */
  owner: string | undefined;
  form: KnowledgeBaseForm;
  canWrite: boolean;
  update(patch: Partial<KnowledgeBaseForm>): void;
}) {
  return (
    <>
      <DataStoreChoice
        source={source}
        owner={owner}
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

/**
 * The Data Store the Knowledge Base reads, chosen from those the reader may read: its own
 * workspace's and the instance's.
 */
function DataStoreChoice({
  source,
  owner,
  value,
  disabled,
  onChange
}: {
  source: KnowledgeBaseSource;
  owner: string | undefined;
  value: string;
  disabled: boolean;
  onChange(dataStore: string): void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const read = source.useDataStores(search, owner);
  const stores = read.status === "ready" ? read.data.items : [];
  const more = read.status === "ready" ? read.data.more : undefined;
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
        more={more && { loading: more.loading, onLoad: more.load }}
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
