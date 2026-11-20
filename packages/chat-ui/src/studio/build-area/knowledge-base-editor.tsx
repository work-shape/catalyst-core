import { Database, FolderSync, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import {
  KNOWLEDGE_DEFAULT_KEYWORD_LANGUAGES,
  KNOWLEDGE_DOCUMENT_FORMATS,
  KNOWLEDGE_KEYWORD_LANGUAGES
} from "@work-shape/catalyst-core";
import {
  Badge,
  Banner,
  Checkbox,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  DropdownMenuItem,
  EmptyState,
  Field,
  Input,
  Picker,
  PickerButton,
  Section,
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
import { scrollToSection } from "./build-scroll";
import { DataFlowList, useWorkflowPage } from "./data-flows";
import { hasDataFlows, type DataFlowRole } from "./data-flows-model";
import { ReadState } from "./data-store-read-state";
import { KnowledgeBaseAgents, KnowledgeBaseHolders } from "./knowledge-base-access";
import {
  KnowledgeAsk,
  KnowledgeStatus,
  KnowledgeTablesAttention,
  KnowledgeTestQuery
} from "./knowledge-base-checks";
import { KnowledgeDocuments, useKnowledgeIntake } from "./knowledge-base-documents";
import { KnowledgeSourceChoice } from "./knowledge-base-source-choice";
import { KnowledgeSourceConnectDialog, KnowledgeSourcesSection } from "./knowledge-base-sources";
import { newKnowledgeSource } from "./knowledge-sources-model";
import { KnowledgeTestSearch } from "./knowledge-base-test-search";
import {
  knowledgeBaseFormToConfig,
  knowledgeBasePublishesOnCreate,
  knowledgeTableLabel,
  knowledgeTableRows,
  type KnowledgeBaseForm,
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
 * a search to try. With tables, the page says in one line what agents do with them, lists the
 * tables by a name a person reads with a sentence each, and once published takes a question in
 * plain words for the chat beside it; the Data Store, and under Advanced whether the tables can
 * be read and a statement to try, wait folded under Settings, and a check that could not read
 * a table says so at the top. Before its first publish, one notice under the head says what
 * publishing opens, in place of those sections. The frame saves the form as a draft and
 * publishes it.
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
  const { canWrite, asset, onNewTitle } = frame;
  // The page of a new Knowledge Base asks the instance about the id its name makes.
  useEffect(() => {
    onNewTitle?.(form.title);
  }, [onNewTitle, form.title]);
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
    // A refusal of the source may be of the Data Store, which is chosen under Settings: they
    // open, so the picker that mends it shows with the refusal beside it.
    if (asset !== undefined && !documents && refusalsOf(answer, "source").length > 0) {
      setSettingsOpen(true);
    }
    state.setOutcome(answer);
    return answer;
  };
  const published = asset?.publishedRevision;
  const documents = form.holds === "documents";
  // The page of an existing one of tables holds its folds itself: Settings start open where no
  // Data Store is chosen yet, which is chosen there, and the notice of a table that cannot be
  // read opens them down to the status.
  const [settingsOpen, setSettingsOpen] = useState(
    () => asset !== undefined && initialForm.holds === "tables" && initialForm.dataStore === ""
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const showStatus = () => {
    setSettingsOpen(true);
    setAdvancedOpen(true);
    // Once both folds show: only the page's content is moved, to under its pinned head, and
    // the focus goes to the heading of the status.
    window.requestAnimationFrame(() => {
      scrollToSection(document.body, "status");
      const heading = document.querySelector<HTMLElement>("#status h2");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
    });
  };
  // A definition that names no methods searches by meaning and by words, as the instance reads it.
  const semantic = form.methods.length === 0 || form.methods.includes("semantic");
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
        canReindex={frame.draft?.canPublish === true}
      />
    )
  });
  // The formats this instance reads: PDF and DOCX need its document processing, the same module
  // switch the instance reads them by. Without the settings, the text formats.
  const uploadDescription = t(
    semantic
      ? "knowledge.holdsDocumentsDescriptionSemantic"
      : "knowledge.holdsDocumentsDescription",
    {
      formats: uploadFormatList(
        uploadFormats(
          settings?.config.modules.documents?.enabled === true
            ? KNOWLEDGE_DOCUMENT_FORMATS
            : undefined
        ),
        locale
      )
    }
  );
  // Whether the instance offers synced sources to this reader: a Connection that syncs folders
  // exists, or one can be made. Add then offers connecting a folder beside uploading files.
  const sourceConnections = source.useSourceConnections?.("", frame.owner);
  const sourceTypes = source.useSourceTypes?.();
  const offersSources =
    canWrite &&
    ((sourceConnections?.status === "ready" && sourceConnections.data.items.length > 0) ||
      (sourceTypes !== undefined && sourceTypes.length > 0));
  const [connecting, setConnecting] = useState(false);
  // Where every document comes from a synced source, the page's main action is Sync now: a file
  // added by hand would lie beside the synced ones and never sync, so both ways to add wait in
  // the head's menu.
  const intake = useKnowledgeIntake(source, asset?.name ?? "", documents ? published : undefined);
  const addsInMenu = canWrite && live && documents && intake.way === "synced";
  const [uploading, setUploading] = useState(false);
  // On the page of a published one of documents the sources are the first rows of its list.
  const sourceRows = live && documents;
  // A new one names its synced source with where its knowledge comes from; an existing one
  // connects more through Add documents.
  const sourcesSection = (
    <>
      <KnowledgeSourcesSection
        source={source}
        knowledgeBase={asset?.name}
        published={published}
        owner={frame.owner}
        sources={form.sources}
        canWrite={canWrite}
        canPublish={frame.draft?.canPublish === true}
        workflows={dataFlows?.fills}
        workflowPage={workflowPage}
        adding={asset !== undefined && !sourceRows}
        layout={sourceRows ? "rows" : "cards"}
        onChange={(sources) => update({ sources })}
      />
      {sourceRows && refusalsOf(outcome, "sources").length > 0 ? (
        // Inside the frame of the list, inset as its rows are.
        <div className="border-b px-3 py-2">
          <FieldRefusals messages={refusalsOf(outcome, "sources")} />
        </div>
      ) : sourceRows ? null : (
        <FieldRefusals messages={refusalsOf(outcome, "sources")} />
      )}
    </>
  );

  const aboutSection: AssetSection = {
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
        {/* An existing one of documents has no Source section: what refuses it is said here. */}
        {asset !== undefined && documents ? (
          <FieldRefusals messages={refusalsOf(outcome, "source")} />
        ) : null}
      </>
    ),
    ...(asset !== undefined && documents ? { refusalField: "source" as const } : {})
  };
  // Where its knowledge comes from: chosen on a new one, and the tables of one that reads a
  // Data Store. An existing one of documents says it with its documents and has no such section.
  const sourceSection: AssetSection = {
    id: "source",
    label: t("knowledge.sourceTitle"),
    description: t(
      !documents
        ? "knowledge.sourceDescription"
        : semantic
          ? "knowledge.sourceDocumentsDescriptionSemantic"
          : "knowledge.sourceDocumentsDescription"
    ),
    ...(documents ? {} : { count: form.tables.length }),
    refusalField: "source",
    body: (
      <>
        <KnowledgeSourceChoice
          source={source}
          owner={frame.owner}
          form={form}
          canWrite={canWrite}
          uploadDescription={uploadDescription}
          update={update}
        />
        {documents ? (
          asset === undefined && form.sources.length > 0 ? (
            sourcesSection
          ) : null
        ) : (
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
  };
  // The tables of an existing one, in plain words: the main content of its page. What refuses
  // its source is said here, where the tables are.
  const tablesSection: AssetSection = {
    id: "source",
    label: t("knowledge.tables"),
    description: t("knowledge.tablesDescription"),
    count: form.tables.length,
    refusalField: "source",
    body: (
      <>
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
  };
  // The Data Store an existing one reads is chosen once and waits under Settings.
  const dataStoreSection: AssetSection = {
    id: "data-store",
    label: t("knowledge.dataStore"),
    description: t("knowledge.dataStoreDescription"),
    body: (
      <>
        <DataStoreChoice
          source={source}
          owner={frame.owner}
          value={form.dataStore}
          disabled={!canWrite}
          onChange={(dataStore) =>
            update({ dataStore, tables: dataStore === form.dataStore ? form.tables : [] })
          }
        />
        {/* A refusal of the source does not say whether it is of the store or of a table. */}
        <FieldRefusals messages={refusalsOf(outcome, "source")} />
      </>
    )
  };
  // Before its first publish the synced sources of one of documents stand as a section of
  // their own; once it is published they are the first rows of its documents.
  const sourcesSections: AssetSection[] =
    documents && asset !== undefined && !sourceRows && source.useSourceConnections
      ? [
          {
            id: "sources",
            label: t("knowledgeSources.title"),
            description: t("knowledgeSources.description"),
            count: form.sources.length,
            refusalField: "sources" as const,
            body: sourcesSection
          }
        ]
      : [];
  // What only a published one has: its documents, or a question about its tables to try.
  const documentsSections: AssetSection[] =
    live && documents
      ? [
          {
            id: "documents",
            label: t("knowledge.documentsTitle"),
            bare: true,
            refusalField: "sources" as const,
            body: (
              <KnowledgeDocuments
                source={source}
                knowledgeBase={asset.name}
                publishedRevision={published}
                canWrite={canWrite}
                sources={sourcesSection}
                adding={uploading}
                onAdding={setUploading}
                {...(offersSources ? { onConnect: () => setConnecting(true) } : {})}
              />
            )
          }
        ]
      : [];
  const checkSections: AssetSection[] = !live
    ? []
    : documents
      ? [
          statusSection(asset.name, published),
          {
            id: "test",
            label: t("knowledge.searchTitle"),
            description: t("knowledge.searchDescription"),
            body: <KnowledgeTestSearch source={source} knowledgeBase={asset.name} />
          }
        ]
      : [];
  // A question in plain words, for the chat beside the page, where the page has one.
  const { askInChat } = source;
  const askSections: AssetSection[] =
    live && !documents && askInChat
      ? [
          {
            id: "test",
            label: t("knowledge.askTitle"),
            body: <KnowledgeAsk ask={askInChat} agents={agents} />
          }
        ]
      : [];
  // What only whoever runs it reads, folded once more inside Settings: whether the published
  // version can read its tables, by their names, and one SQL statement to try.
  const tablesAdvancedSections: AssetSection[] =
    live && !documents
      ? [
          {
            id: "advanced",
            label: t("knowledge.advancedTitle"),
            bare: true,
            body: (
              <Disclosure
                variant="row"
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                data-knowledge-advanced=""
              >
                <DisclosureTrigger data-knowledge-advanced-trigger="">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="text-title-sm text-foreground">
                      {t("knowledge.advancedTitle")}
                    </span>
                    <span className="text-caption">{t("knowledge.advancedTablesHint")}</span>
                  </span>
                </DisclosureTrigger>
                {/* Kept in the page while folded: the notice at the top goes to its status. */}
                <DisclosureContent keepMounted>
                  {[
                    statusSection(asset.name, published),
                    {
                      id: "sql-test",
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
                  ].map((section) => (
                    <Section
                      key={section.id}
                      id={section.id}
                      layout="stacked"
                      title={section.label}
                      description={section.description}
                    >
                      {section.body}
                    </Section>
                  ))}
                </DisclosureContent>
              </Disclosure>
            )
          }
        ]
      : [];
  const availabilitySections: AssetSection[] = availability
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
              fixedReason={availability.fixedReason}
              hiddenHint={t("configAvailabilityAssetHiddenHint")}
              refusals={refusalsOf(outcome, "availability")}
            />
          )
        }
      ]
    : [];
  const agentsSections: AssetSection[] =
    agents === undefined || stateRead.status !== "ready"
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
        ];
  // Who was given it by itself is shown to who is shown rights at all, as on a Connection.
  const accessSections: AssetSection[] =
    holders.status === "hidden"
      ? []
      : [
          {
            id: "access",
            label: t("knowledge.accessTitle"),
            description: t("knowledge.accessDescription"),
            count: holders.status === "ready" ? holders.holders.length : undefined,
            body: <KnowledgeBaseHolders read={holders} />
          }
        ];
  const advancedSections: AssetSection[] = documents
    ? [
        {
          id: "advanced",
          label: t("knowledge.advancedTitle"),
          description: t("knowledge.advancedDescription"),
          refusalField: "indexing" as const,
          body: (
            <>
              <KeywordLanguages
                languages={form.languages}
                disabled={!canWrite}
                onChange={(languages) => update({ languages })}
              />
              <FieldRefusals messages={refusalsOf(outcome, "indexing")} />
            </>
          )
        }
      ]
    : [];
  // A new one is a form to fill in: every section open, in the order it is filled. An existing
  // one shows what it holds and keeps the rest folded under Settings: of documents, all but its
  // documents; of tables, all but its tables and the question to try.
  const sections: AssetSection[] =
    asset === undefined
      ? [aboutSection, sourceSection, ...availabilitySections, ...advancedSections]
      : documents
        ? [...sourcesSections, ...documentsSections]
        : [tablesSection, ...askSections];
  const folded: AssetSection[] =
    asset === undefined
      ? []
      : documents
        ? [
            aboutSection,
            ...availabilitySections,
            ...agentsSections,
            ...accessSections,
            ...checkSections,
            ...advancedSections,
            ...flowSections
          ]
        : [
            aboutSection,
            dataStoreSection,
            ...availabilitySections,
            ...agentsSections,
            ...accessSections,
            ...flowSections,
            ...tablesAdvancedSections
          ];

  return (
    <AssetEditorShell
      frame={frame}
      title={form.title.trim() || form.name || t("knowledge.new")}
      sections={sections}
      {...(asset === undefined
        ? {}
        : {
            // One of tables says what agents do with them; what it holds is said by its tables.
            lead: documents ? form.description : t("knowledge.tablesLead"),
            settings: {
              label: t("knowledge.settingsTitle"),
              hint: t(documents ? "knowledge.settingsHint" : "knowledge.settingsHintTables"),
              sections: folded,
              ...(documents ? {} : { open: settingsOpen, onOpenChange: setSettingsOpen })
            },
            // The page is its list, or its tables and a question, and one folded line: no outline.
            outline: false
          })}
      {...(addsInMenu
        ? {
            menu: (
              <>
                <DropdownMenuItem
                  icon={<Upload aria-hidden="true" />}
                  onSelect={() => setUploading(true)}
                >
                  <span data-knowledge-menu-upload="">{t("knowledge.addUpload")}</span>
                </DropdownMenuItem>
                {offersSources ? (
                  <DropdownMenuItem
                    icon={<FolderSync aria-hidden="true" />}
                    onSelect={() => setConnecting(true)}
                  >
                    <span data-knowledge-menu-folder="">{t("knowledge.addConnect")}</span>
                  </DropdownMenuItem>
                ) : null}
              </>
            )
          }
        : {})}
      control={{
        changes: changedFields + (availabilityEdit.changed ? 1 : 0),
        submit,
        discard: () => {
          state.discard();
          availabilityEdit.discard();
        }
      }}
      notices={
        <>
          {asset !== undefined && published === undefined ? (
            <Banner tone="info" className="mb-3" data-knowledge-not-published="">
              {t(documents ? "knowledge.notPublishedDocuments" : "knowledge.notPublished")}
            </Banner>
          ) : null}
          {/* What needs a person stands at the top: a table the last check could not read. */}
          {asset !== undefined && published !== undefined && !documents ? (
            <KnowledgeTablesAttention
              source={source}
              knowledgeBase={asset.name}
              publishedRevision={published}
              onShow={showStatus}
            />
          ) : null}
          {connecting ? (
            <KnowledgeSourceConnectDialog
              source={source}
              owner={frame.owner}
              onClose={() => setConnecting(false)}
              onAdd={(connection, connectorType) => {
                setConnecting(false);
                update({
                  sources: [
                    ...form.sources,
                    newKnowledgeSource(connection, form.sources, connectorType)
                  ]
                });
              }}
            />
          ) : null}
        </>
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

/**
 * The keyword languages of a Knowledge Base of documents (KB-12): a box per language keyword
 * search can stem by. One that lists none has German and English, shown checked. The last one
 * checked stays: a Knowledge Base keeps one.
 */
function KeywordLanguages({
  languages,
  disabled,
  onChange
}: {
  languages: readonly string[];
  disabled: boolean;
  onChange(languages: string[]): void;
}) {
  const { locale, t } = useTranslation();
  const names = new Intl.DisplayNames([locale], { type: "language" });
  const nameOf = (language: string) => names.of(language) ?? language;
  // By the name the reader reads, not by its code.
  const listed = [...KNOWLEDGE_KEYWORD_LANGUAGES].sort((left, right) =>
    nameOf(left).localeCompare(nameOf(right), locale)
  );
  const chosen: readonly string[] =
    languages.length > 0 ? languages : KNOWLEDGE_DEFAULT_KEYWORD_LANGUAGES;
  const toggle = (language: string, on: boolean) =>
    onChange(
      KNOWLEDGE_KEYWORD_LANGUAGES.filter((each) => (each === language ? on : chosen.includes(each)))
    );
  return (
    <Field label={t("knowledge.keywordLanguagesLabel")} hint={t("knowledge.keywordLanguagesHint")}>
      <ul
        aria-label={t("knowledge.keywordLanguagesLabel")}
        className="grid gap-2 sm:grid-cols-3"
        data-knowledge-keyword-languages=""
      >
        {listed.map((language) => {
          const checked = chosen.includes(language);
          return (
            <li key={language} data-knowledge-keyword-language={language}>
              <Checkbox
                label={nameOf(language)}
                checked={checked}
                disabled={disabled || (checked && chosen.length === 1)}
                onCheckedChange={(on) => toggle(language, on)}
              />
            </li>
          );
        })}
      </ul>
    </Field>
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
  const { t } = useTranslation();
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
      <Field label={t("knowledge.tables")} hint={t("knowledge.tablesHint")}>
        <TableChoice
          source={source}
          store={form.dataStore || undefined}
          tables={form.tables}
          disabled={!canWrite}
          onChange={(tables) => update({ tables })}
        />
      </Field>
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
 * The tables of the chosen store, each by a name a person reads with the table's own name small
 * under it, a box that lets agents answer from it, and the sentence they read about a row,
 * which takes the lines it needs. A described table the store does not have stays listed, with
 * that said, until the box is cleared. No `Field` hands the boxes `required`: a box left clear
 * is no error.
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
          <ul
            aria-label={t("knowledge.tables")}
            className="grid min-w-0 divide-y border-t"
            data-knowledge-tables=""
          >
            {rows.map((row) => {
              const label = knowledgeTableLabel(row.name);
              return (
                <li
                  key={row.name}
                  className="grid min-w-0 gap-2 py-3"
                  data-knowledge-table={row.name}
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <Checkbox
                      label={label}
                      description={<code className="font-mono break-all">{row.name}</code>}
                      checked={row.described !== undefined}
                      disabled={disabled}
                      onCheckedChange={(on) => toggle(row.name, on)}
                    />
                    {row.inStore ? null : (
                      <Badge tone="warning" size="sm">
                        {t("knowledge.tableMissing")}
                      </Badge>
                    )}
                  </div>
                  {row.described ? (
                    // Under the name, not under the box.
                    <div className="min-w-0 pl-6">
                      <Textarea
                        grows
                        rows={2}
                        // Two tables may read alike: the table's own name tells them apart.
                        aria-label={t("knowledge.tableDescription", {
                          table: `${label} (${row.name})`
                        })}
                        placeholder={t("knowledge.tableDescription", { table: label })}
                        value={row.described.description}
                        required
                        readOnly={disabled}
                        onChange={(event) => describe(row.name, event.target.value)}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        );
      }}
    </ReadState>
  );
}
