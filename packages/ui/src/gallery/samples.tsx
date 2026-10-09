import {
  ArrowLeft,
  BookOpen,
  Copy,
  Download,
  Ellipsis,
  FolderOpen,
  Plug,
  Plus,
  Search,
  SearchX,
  Trash2
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { FilterBar } from "../data/filter-bar";
import { List, ListRow } from "../data/list-row";
import { Banner } from "../feedback/banner";
import { EmptyState } from "../feedback/empty-state";
import { Field } from "../forms/field";
import { Input, Textarea } from "../forms/input";
import { SaveBar } from "../forms/save-bar";
import { Select } from "../forms/select";
import { Switch } from "../forms/switch";
import { SubRail, type SubRailGroup } from "../navigation/sub-rail";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../overlays/dropdown-menu";
import { Picker, type PickerOptionGroup } from "../overlays/picker";
import { Avatar } from "../status/avatar";
import { Badge, type BadgeTone } from "../status/badge";
import { ScopeChip } from "../status/chip";
import { Page } from "../structure/page";
import { PageHeader } from "../structure/page-header";
import { Section } from "../structure/section";
import type { GalleryText } from "./text";

// A workspace's own colour pair, as a user picks one. A chart colour stands in for it here.
const workspaceAccent = { background: "var(--chart-4)", foreground: "var(--background)" };

/** A link of a sample page: it shows how a row opens its object and goes nowhere. */
function sampleLink() {
  return <a href="#" onClick={(event) => event.preventDefault()} />;
}

function noop(): void {
  // A sample page has one page per rail and stores nothing.
}

type AssetScope = "workspace" | "instance";

function AssetScopeChip({ scope, text }: { scope: AssetScope; text: GalleryText }) {
  return scope === "workspace" ? (
    <ScopeChip size="sm" scope="workspace" name={text.buildWorkspace} accent={workspaceAccent} />
  ) : (
    <ScopeChip
      size="sm"
      scope="instance"
      name={text.buildInstance}
      readOnlyLabel={text.buildInstanceReadOnly}
    />
  );
}

interface KnowledgeBaseRow {
  id: string;
  name: string;
  status: string;
  scope: AssetScope;
  state: { tone: BadgeTone; label: string };
  updated: string;
}

function knowledgeBaseRows(text: GalleryText): KnowledgeBaseRow[] {
  return [
    {
      id: "handbook",
      name: text.buildHandbook,
      status: text.buildHandbookStatus,
      scope: "workspace",
      state: { tone: "neutral", label: text.stateDraft },
      updated: text.today
    },
    {
      id: "contracts",
      name: text.buildContracts,
      status: text.buildContractsStatus,
      scope: "workspace",
      state: { tone: "success", label: text.statePublished },
      updated: text.yesterday
    },
    {
      id: "policies",
      name: text.buildPolicies,
      status: text.buildPoliciesStatus,
      scope: "instance",
      state: { tone: "info", label: text.stateIngesting },
      updated: text.today
    },
    {
      id: "prices",
      name: text.buildPrices,
      status: text.buildPricesStatus,
      scope: "instance",
      state: { tone: "danger", label: text.stateIngestionFailed },
      updated: text.lastWeek
    }
  ];
}

function AssetMenu({ text, children }: { text: GalleryText; children?: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={text.moreActions}>
          <Ellipsis aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {children}
        <DropdownMenuItem icon={<Copy aria-hidden="true" />}>{text.menuDuplicate}</DropdownMenuItem>
        <DropdownMenuItem icon={<Download aria-hidden="true" />}>
          {text.assetExport}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Trash2 aria-hidden="true" />} tone="danger">
          {text.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ScopeFilter = "all" | AssetScope;

const scopeFilters: readonly ScopeFilter[] = ["all", "workspace", "instance"];

function toScopeFilter(value: string): ScopeFilter {
  return scopeFilters.find((candidate) => candidate === value) ?? "all";
}

/** The list of one kind in Build: the kinds as a rail, filters, rows and what an empty result shows. */
function BuildListSample({ text }: { text: GalleryText }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const kinds: SubRailGroup[] = [
    {
      id: "kinds",
      items: [
        { id: "agents", label: text.buildAgents, count: 4 },
        { id: "skills", label: text.buildSkills, count: 9 },
        { id: "connections", label: text.buildConnections, count: 2 },
        { id: "knowledge", label: text.buildKnowledgeBases, count: 4 },
        { id: "data-stores", label: text.buildDataStores, count: 0 },
        { id: "guardrails", label: text.buildGuardrails, count: 3 }
      ]
    }
  ];
  const needle = query.trim().toLocaleLowerCase();
  const rows = knowledgeBaseRows(text).filter(
    (row) =>
      (scope === "all" || row.scope === scope) && row.name.toLocaleLowerCase().includes(needle)
  );

  return (
    <Page
      subRail={
        <SubRail
          mode="routes"
          label={text.buildKinds}
          groups={kinds}
          value="knowledge"
          onValueChange={noop}
        />
      }
    >
      <PageHeader
        headingLevel={2}
        title={text.buildKnowledgeBases}
        description={text.buildListDescription}
        primaryAction={
          <Button>
            <Plus aria-hidden="true" />
            {text.buildNewKnowledgeBase}
          </Button>
        }
      />
      <div className="grid gap-4">
        <FilterBar
          search={
            <Input
              type="search"
              aria-label={text.buildSearch}
              placeholder={text.buildSearch}
              leadingIcon={<Search aria-hidden="true" />}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          }
          filters={
            <Select
              className="w-44"
              aria-label={text.buildScope}
              value={scope}
              onChange={(event) => setScope(toScopeFilter(event.currentTarget.value))}
            >
              <option value="all">{text.buildScopeAll}</option>
              <option value="workspace">{text.buildWorkspace}</option>
              <option value="instance">{text.buildInstance}</option>
            </Select>
          }
          count={text.buildShown.replace("{count}", String(rows.length))}
        />
        {rows.length === 0 ? (
          <EmptyState
            icon={<SearchX aria-hidden="true" />}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setScope("all");
                }}
              >
                {text.buildClearSearch}
              </Button>
            }
          >
            {text.buildEmpty}
          </EmptyState>
        ) : (
          <List aria-label={text.buildListLabel}>
            {rows.map((row) => (
              <ListRow
                key={row.id}
                link={sampleLink()}
                leading={
                  <Avatar kind="app" name={row.name} icon={<BookOpen aria-hidden="true" />} />
                }
                title={row.name}
                description={row.status}
                chips={
                  <>
                    <AssetScopeChip scope={row.scope} text={text} />
                    <Badge size="sm" tone={row.state.tone}>
                      {row.state.label}
                    </Badge>
                  </>
                }
                time={row.updated}
                actions={
                  <AssetMenu text={text}>
                    <DropdownMenuItem icon={<FolderOpen aria-hidden="true" />}>
                      {text.buildOpen}
                    </DropdownMenuItem>
                  </AssetMenu>
                }
              />
            ))}
          </List>
        )}
      </div>
    </Page>
  );
}

interface SourceRow {
  id: string;
  name: string;
  status: string;
  scope: AssetScope;
}

/** One asset: the header every asset page has, a section index, fields, linked rows and history. */
function AssetPageSample({ text }: { text: GalleryText }) {
  // The gallery can show the same sample more than once, so the anchors are made unique.
  const prefix = useId();
  const [added, setAdded] = useState<readonly SourceRow[]>([]);
  const sources: SourceRow[] = [
    {
      id: "drive",
      name: text.assetSourceDrive,
      status: text.assetSourceDriveStatus,
      scope: "workspace"
    },
    {
      id: "wiki",
      name: text.assetSourceWiki,
      status: text.assetSourceWikiStatus,
      scope: "instance"
    },
    ...added
  ];
  const archive: SourceRow = {
    id: "archive",
    name: text.assetSourceArchive,
    status: text.assetSourceArchiveStatus,
    scope: "workspace"
  };
  const addSource = (source: SourceRow) =>
    setAdded((rows) => (rows.some((row) => row.id === source.id) ? rows : [...rows, source]));
  const connection = (icon: ReactNode, name: string) => (
    <Avatar kind="app" size="sm" name={name} icon={icon} />
  );
  const pickable: PickerOptionGroup[] = [
    {
      heading: text.pickerGroupWorkspace,
      options: [
        {
          value: archive.id,
          label: archive.name,
          description: archive.status,
          leading: connection(<Plug aria-hidden="true" />, archive.name)
        }
      ]
    },
    {
      heading: text.pickerGroupInstance,
      options: [
        {
          value: "crm",
          label: text.assetSourceCrm,
          disabledReason: text.assetSourceCrmReason,
          leading: connection(<Plug aria-hidden="true" />, text.assetSourceCrm)
        }
      ]
    }
  ];
  const anchors = {
    overview: `${prefix}overview`,
    sources: `${prefix}sources`,
    search: `${prefix}search`,
    history: `${prefix}history`
  };
  const index: SubRailGroup[] = [
    {
      id: "sections",
      items: [
        { id: anchors.overview, label: text.assetOverview },
        { id: anchors.sources, label: text.assetSources, count: sources.length },
        { id: anchors.search, label: text.assetSearch },
        { id: anchors.history, label: text.assetHistory }
      ]
    }
  ];
  const revisions = [
    {
      id: "draft",
      title: text.assetRevisionDraft,
      status: text.assetRevisionDraftStatus,
      person: text.navAccount,
      time: text.today
    },
    {
      id: "two",
      title: text.assetRevisionTwo,
      status: text.assetRevisionTwoStatus,
      person: text.personName,
      time: text.yesterday
    },
    {
      id: "one",
      title: text.assetRevisionOne,
      status: text.assetRevisionOneStatus,
      person: text.navAccount,
      time: text.lastWeek
    }
  ];

  return (
    <>
      <PageHeader
        variant="detail"
        headingLevel={2}
        back={
          <IconButton label={text.assetBack}>
            <ArrowLeft aria-hidden="true" />
          </IconButton>
        }
        title={text.buildHandbook}
        scope={<AssetScopeChip scope="workspace" text={text} />}
        state={<Badge>{text.stateDraft}</Badge>}
        secondaryActions={<Button variant="ghost">{text.assetDiscardDraft}</Button>}
        primaryAction={<Button>{text.publish}</Button>}
        overflow={<AssetMenu text={text} />}
      />
      <Banner
        layout="page"
        tone="info"
        title={text.assetBannerTitle}
        action={
          <Button variant="ghost" size="sm">
            {text.assetBannerAction}
          </Button>
        }
      >
        {text.assetBanner}
      </Banner>
      <Page
        subRail={<SubRail mode="anchors" belowHeader label={text.assetSections} groups={index} />}
      >
        <Section
          id={anchors.overview}
          headingLevel={3}
          title={text.assetOverview}
          description={text.assetOverviewDescription}
        >
          <Field label={text.name} hint={text.assetNameHint} required>
            <Input defaultValue={text.buildHandbook} />
          </Field>
          <Field label={text.description} optional>
            <Textarea defaultValue={text.assetDescriptionValue} />
          </Field>
        </Section>
        <Section
          id={anchors.sources}
          headingLevel={3}
          title={text.assetSources}
          description={text.assetSourcesDescription}
          count={sources.length}
          action={
            <Picker
              search
              align="end"
              options={pickable}
              value={undefined}
              create={{
                label: text.assetCreateConnection,
                onSelect: (search) =>
                  addSource({
                    id: "created",
                    name: search === "" ? text.assetCreateConnection : search,
                    status: text.stateNeedsReconnect,
                    scope: "workspace"
                  })
              }}
              onValueChange={(value) => {
                if (value === archive.id) {
                  addSource(archive);
                }
              }}
            >
              <Button variant="outline" size="sm">
                <Plus aria-hidden="true" />
                {text.assetAddSource}
              </Button>
            </Picker>
          }
        >
          <List aria-label={text.assetSourcesLabel}>
            {sources.map((source) => (
              <ListRow
                key={source.id}
                link={sampleLink()}
                leading={connection(<Plug aria-hidden="true" />, source.name)}
                title={source.name}
                description={source.status}
                chips={<AssetScopeChip scope={source.scope} text={text} />}
              />
            ))}
          </List>
        </Section>
        <Section
          id={anchors.search}
          headingLevel={3}
          title={text.assetSearch}
          description={text.assetSearchDescription}
        >
          <Field label={text.assetSearchMode}>
            <Select defaultValue="hybrid">
              <option value="hybrid">{text.assetSearchModeHybrid}</option>
              <option value="keyword">{text.assetSearchModeKeyword}</option>
            </Select>
          </Field>
          <Field layout="inline" label={text.assetSemantic} hint={text.assetSemanticHint}>
            <Switch defaultChecked />
          </Field>
        </Section>
        <Section
          id={anchors.history}
          headingLevel={3}
          title={text.assetHistory}
          description={text.assetHistoryDescription}
        >
          <List aria-label={text.assetHistoryLabel}>
            {revisions.map((revision) => (
              <ListRow
                key={revision.id}
                leading={<Avatar kind="person" size="sm" name={revision.person} />}
                title={revision.title}
                description={revision.status}
                time={revision.time}
              />
            ))}
          </List>
        </Section>
      </Page>
    </>
  );
}

/** A settings page: the settings rail, sections of fields and switches, and the save bar. */
function SettingsFormSample({ text }: { text: GalleryText }) {
  const [saved, setSaved] = useState(false);
  const pages: SubRailGroup[] = [
    {
      id: "you",
      label: text.subRailYou,
      items: [
        { id: "profile", label: text.subRailProfile },
        { id: "language", label: text.settingsLanguage },
        { id: "security", label: text.subRailSecurity },
        { id: "api-keys", label: text.settingsApiKeys }
      ]
    },
    {
      id: "workspace",
      label: text.subRailWorkspace,
      items: [
        { id: "general", label: text.subRailGeneral },
        { id: "members", label: text.subRailMembers, count: 3, countTone: "primary" },
        { id: "defaults", label: text.subRailDefaults }
      ]
    },
    {
      id: "instance",
      label: text.settingsGroupInstance,
      items: [
        { id: "users", label: text.settingsUsers },
        { id: "roles", label: text.settingsRoles }
      ]
    }
  ];

  return (
    <form
      className="flex min-h-full flex-col"
      onChange={() => setSaved(false)}
      onReset={() => setSaved(false)}
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(true);
      }}
    >
      <Page
        className="flex-1"
        width="narrow"
        subRail={
          <SubRail
            mode="routes"
            label={text.subRailSettings}
            groups={pages}
            value="general"
            onValueChange={noop}
          />
        }
      >
        <PageHeader
          headingLevel={2}
          title={text.subRailGeneral}
          description={text.settingsGeneralDescription}
        />
        <Section
          layout="stacked"
          headingLevel={3}
          title={text.settingsIdentity}
          description={text.settingsIdentityDescription}
        >
          <Field label={text.name} hint={text.settingsWorkspaceNameHint} required>
            <Input defaultValue={text.buildWorkspace} maxLength={40} />
          </Field>
          <Field label={text.description} optional>
            <Textarea defaultValue={text.settingsWorkspaceDescription} />
          </Field>
        </Section>
        <Section
          layout="stacked"
          headingLevel={3}
          title={text.settingsConversations}
          description={text.settingsConversationsDescription}
        >
          <Field label={text.settingsDefaultAgent} hint={text.settingsDefaultAgentHint}>
            <Select defaultValue="support">
              <option value="support">{text.rowAgent}</option>
              <option value="research">{text.agentResearch}</option>
              <option value="contracts">{text.agentContracts}</option>
            </Select>
          </Field>
          <Field layout="inline" label={text.settingsPrivate} hint={text.settingsPrivateHint}>
            <Switch defaultChecked />
          </Field>
          <Field
            layout="inline"
            label={text.settingsJoinRequests}
            hint={text.settingsJoinRequestsHint}
          >
            <Switch defaultChecked />
          </Field>
          <Field layout="inline" label={text.settingsDigest} hint={text.settingsDigestHint}>
            <Switch />
          </Field>
        </Section>
      </Page>
      <SaveBar
        mode="sticky"
        label={text.saveChanges}
        hint={text.saveHint}
        saved={saved}
        savedLabel={text.saveSaved}
        secondaryAction={
          <Button variant="ghost" type="reset">
            {text.saveDiscard}
          </Button>
        }
      />
    </form>
  );
}

/** One page built from the library alone, with the labels of the navigation. */
export interface SamplePage {
  id: string;
  title(text: GalleryText): string;
  render(text: GalleryText): ReactNode;
}

/**
 * The three sample pages: a Build list, an asset page and a settings form. They are where the
 * look as a whole is judged, and a builder starts a new page from the one that is closest.
 */
export const samplePages: readonly SamplePage[] = [
  {
    id: "build-list",
    title: (text) => text.sampleBuildList,
    render: (text) => <BuildListSample text={text} />
  },
  {
    id: "asset-page",
    title: (text) => text.sampleAssetPage,
    render: (text) => <AssetPageSample text={text} />
  },
  {
    id: "settings-form",
    title: (text) => text.sampleSettingsForm,
    render: (text) => <SettingsFormSample text={text} />
  }
];
