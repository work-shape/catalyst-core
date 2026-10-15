import { Database } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Picker,
  PickerButton,
  Textarea
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { AssetEditorShell, useAssetForm, type AssetSection } from "./asset-editor-shell";
import { FieldRefusals } from "./asset-form-fields";
import { countChangedFields } from "./asset-form-model";
import type { BuildAssetEditorProps } from "./build-asset-kind";
import { refusalsOf } from "./build-refusals";
import { ReadState } from "./data-store-read-state";
import { KnowledgeStatus, KnowledgeTestQuery } from "./knowledge-base-checks";
import {
  knowledgeBaseFormToConfig,
  knowledgeTableRows,
  type KnowledgeBaseForm,
  type KnowledgeTableForm
} from "./knowledge-base-model";
import type { KnowledgeBaseSource } from "./knowledge-base-source";

/**
 * The page of one Knowledge Base: what it holds, the Data Store it reads with a sentence per
 * table, and, once published, whether it can read them and a query to try. The frame saves the
 * form as a draft and publishes it.
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
            hint={t("knowledge.descriptionHint")}
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
      description: t("knowledge.sourceDescription"),
      count: form.tables.length,
      refusalField: "source",
      body: (
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
          <FieldRefusals messages={refusalsOf(outcome, "source")} />
        </>
      )
    },
    {
      id: "status",
      label: t("knowledge.statusTitle"),
      description: t("knowledge.statusDescription"),
      body:
        asset && published !== undefined ? (
          <KnowledgeStatus
            source={source}
            knowledgeBase={asset.name}
            publishedRevision={published}
            canCheck={canWrite}
          />
        ) : (
          <EmptyState layout="inline">{t("knowledge.notPublished")}</EmptyState>
        )
    },
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
