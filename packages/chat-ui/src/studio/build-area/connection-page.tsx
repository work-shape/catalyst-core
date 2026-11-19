// @rights-screen: included in the rights wording guard.
import { KeyRound, Shield, Users } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Chip,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  EmptyState,
  InlineError,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  Page,
  PageHeader,
  PageLead,
  Section,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { roleLabelKey } from "../../admin/access/role-model";
import { verbLabel, type RightVerb } from "../../admin/access/right-words";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { discoveredCandidates } from "./connection-approval-model";
import { usePageShown } from "./asset-editor-shell";
import { scrollToSection } from "./build-scroll";
import {
  AssetPlaceLine,
  AssetPlaceRow,
  assetAudience,
  AVAILABILITY_SECTION_ID,
  useKnownWorkspaces
} from "./asset-place";
import type {
  BuildAssetEditorProps,
  BuildAssetViewProps,
  BuildHeadActions
} from "./build-asset-kind";
import { ConnectionAboutEditor } from "./connection-about";
import { catalogueUpdateOf } from "./connection-catalogue-update-model";
import { ConnectionCatalogueUpdate } from "./connection-catalogue-update";
import {
  ConnectionSecretEditor,
  ConnectionSettingsEditor,
  DiscoveredTools,
  TypeTools,
  typeToolsToApprove
} from "./connection-editing";
import {
  discoveryWaitFrom,
  discoveryWaitsForSignIn,
  personContextHeaderOf,
  waitsForDiscovery,
  type DiscoveryWait
} from "./connection-form-model";
import { authSchemeLabel, connectorTypeLabel, CredentialModeField } from "./connection-form";
import { ConnectionPeopleSection, PersonalSignInSection } from "./connection-people";
import { isPersonalConfig, showsPeople } from "./connection-people-model";
import { credentialModeOf } from "./connection-form-model";
import { offerText, type ConnectorTypeOffer } from "./connection-typed-model";
import { ConnectionOperations, EditableOperations } from "./connection-operations";
import { PersonContextSection } from "./connection-person-context";
import { RestToolsSection } from "./connection-rest-tools";
import { ConnectionSignInSection } from "./connection-sign-in-section";
import { ConnectionUsedBy, usedByCount, usedByNames } from "./connection-used-by";
import {
  AUTH_SCHEME_NONE,
  ConnectionStatus,
  HEALTH_VIEWS,
  recordedHealth
} from "./connection-status";
import { withOAuthSettings } from "./connection-sign-in-model";
import { ConnectionTestCredentialSection } from "./connection-test-credential";
import type { ConnectionHoldersRead, ConnectionSource } from "./connection-source";

/** The section of the page that signs the Connection in, or the reader's own account. */
const SIGN_IN_SECTION_ID = "sign-in";

/** A member of the definition that is a text, or nothing. */
function textOf(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** The settings of the definition, by name. They hold no credential: the instance refuses one. */
function settingsOf(config: Record<string, unknown>): [string, unknown][] {
  const { settings } = config;
  return typeof settings === "object" && settings !== null && !Array.isArray(settings)
    ? Object.entries(settings)
    : [];
}

/** One part of the page under a heading of its own. */
interface PageSection {
  id: string;
  label: string;
  description?: string;
  count?: number | undefined;
  body: ReactNode;
}

/**
 * The page of one Connection, for a person who does not set it up: one line of what it does,
 * its sign-in (or its key and test) with the one action that fixes it, and what agents may do
 * with it. Everything else is folded under Settings at its end: the name, how it reaches the
 * service, the people, what uses it, where it is available and who may use it. Of the
 * credential it shows whether it is there. It reads the named members of the definition only,
 * so a reference to the credential in the revision is never on the page.
 *
 * With `editing` the reader changes a Connection made on the instance here: its settings, its
 * key and the tools it accepts. After each change the page waits a while for the discovery
 * the instance starts, so the tools of the server show as they are read.
 */
export function ConnectionPage({
  page,
  back,
  asset,
  actions,
  notice,
  source,
  editing,
  availability
}: Omit<BuildAssetViewProps, "kinds"> & {
  /** The frame's actions for the head: History, and Delete where the reader may delete. */
  actions?: BuildHeadActions;
  /** What the frame says above the content, such as a conflict. */
  notice?: ReactNode;
  source: ConnectionSource;
  editing?: BuildAssetEditorProps;
  /** Where agents can use the Connection, for a reader who may change it. */
  availability?: ReactNode;
}) {
  const { locale, t } = useTranslation();
  usePageShown(page, "asset");
  // Where agents may use a Connection of everyone, beside where it sits (SCOPE-WORDS). Where
  // none may, the chip leads a reader who may change that to "Available in".
  const audience = assetAudience("connection", asset, useKnownWorkspaces(), t, locale);
  // A Connection made here and not yet read waits for its first discovery. A REST API has none:
  // its page reads the Connection again for a while after a write.
  // A type with a form of its own, such as a document source, discovers nothing, and its
  // settings are not the address and key this page edits: they show as they are.
  const { connectorType } = asset.config;
  const offer = (source.useConnectorTypes?.(source.mayTest(asset)) ?? []).find(
    (type) => type.type === connectorType
  );
  // A Connection on the managed client set up from an earlier entry version is updated first.
  const entries = source.useCatalogueEntries?.(source.mayTest(asset));
  const update = editing && entries ? catalogueUpdateOf(asset.config, entries) : undefined;
  const discovers = connectorType !== "http_api" && offer === undefined;
  const formEdits = offer === undefined;
  const { config } = asset;
  const enabled = config.enabled !== false;
  // Each person connects their own account: the page's sign-in is the reader's own.
  const personal = isPersonalConfig(config);
  const signsIn = textOf(config, "authScheme") === "oauth";
  // A page that opens waits only while the Connection was never read and nothing failed, as
  // right after its creation; an off Connection is read by nobody.
  const [wait, setWait] = useState<DiscoveryWait | undefined>(() =>
    editing && discovers && enabled ? { since: Date.now() } : undefined
  );
  const read = source.useDetail(asset.name, wait);
  const holders = source.useHolders(asset.name);
  const detail = read.status === "ready" ? read.detail : undefined;
  const own = source.useOwnSignInState?.(
    asset.name,
    Boolean(editing && discovers && personal && signsIn)
  );
  // Without the sign-in that reads them, the tools are not read: the page says so at once.
  const signIn =
    editing && discovers && detail
      ? discoveryWaitsForSignIn({ personal, signsIn, binding: detail?.binding?.state, own })
      : undefined;
  const waiting =
    signIn === undefined &&
    wait !== undefined &&
    detail !== undefined &&
    waitsForDiscovery(wait, detail, Date.now());
  // Asked for a discovery: the page waits for it, or for a failure written after it asked.
  const asked = () => setWait(discoveryWaitFrom(detail, Date.now()));
  // A write of a personal Connection asks for no discovery: its tools are read on its owner's
  // request alone. The page reads it again once.
  const written = () => setWait(discoveryWaitFrom(detail, Date.now(), !personal && enabled));
  const runtime = config.origin !== "release";
  const title = textOf(config, "displayName") ?? asset.name;
  const headHealth = detail ? recordedHealth(detail) : undefined;
  const personContextHeader = personContextHeaderOf(config);
  // The mappings are admin data: only a reader who may change the Connection reads them.
  const personContext = source.mayTest(asset) ? source.personContext : undefined;
  const mayChange = source.mayTest(asset);
  const status = (
    <>
      {read.status === "loading" ? (
        <SkeletonList rows={2} />
      ) : read.status === "failed" ? (
        <InlineError className="flex flex-wrap items-center justify-between gap-2">
          <span>{read.message ?? t("connections.detailFailed")}</span>
          <Button variant="outline" size="sm" onClick={read.retry}>
            {t("tryAgain")}
          </Button>
        </InlineError>
      ) : (
        <ConnectionStatus
          name={asset.name}
          detail={read.detail}
          needsCredential={textOf(config, "authScheme") !== AUTH_SCHEME_NONE}
          runtime={runtime}
          source={source}
          mayTest={mayChange}
          credentialEditor={
            editing
              ? (retest) => (
                  <ConnectionSecretEditor
                    name={asset.name}
                    revision={asset.revision}
                    secret={read.detail.secret}
                    source={source}
                    written={written}
                    {...(retest ? { retest } : {})}
                    removal={{ frame: editing, config, usedBy: read.detail }}
                  />
                )
              : undefined
          }
        />
      )}
    </>
  );
  // The one state at the top: the sign-in of a Connection that signs in, else its key and test.
  const signInBody = !detail?.oauth ? undefined : personal ? (
    <PersonalSignInSection name={asset.name} title={title} />
  ) : (
    <ConnectionSignInSection
      asset={asset}
      detail={detail}
      source={source}
      mayWrite={mayChange}
      {...(editing
        ? {
            writeOAuth: async (oauth: { clientId?: string; scopes?: string[] }) => {
              const outcome = await editing.save(withOAuthSettings(config, oauth));
              if (!outcome.ok || outcome.revision === undefined)
                throw new Error("The sign-in settings were not saved");
              written();
              return outcome.revision;
            }
          }
        : {})}
      onSignedIn={written}
    />
  );
  // The tools a server names and the Connection does not accept: beside what agents may do
  // while there is one to accept or to wait for, else with the settings.
  const discoveredOpen =
    detail === undefined ||
    waiting ||
    signIn !== undefined ||
    detail.operations.length === 0 ||
    discoveredCandidates(detail.discovered).length > 0;
  const discovered: PageSection[] =
    editing && discovers && read.status !== "failed"
      ? [
          {
            id: "discovered",
            label: t("connections.discoveredTitle"),
            description: t("connections.discoveredDescription"),
            count: detail?.discovered.length,
            body: (
              <DiscoveredTools
                name={asset.name}
                asset={asset}
                frame={editing}
                detail={detail}
                waiting={waiting}
                {...(signIn === undefined
                  ? {}
                  : { signIn: { whose: signIn, section: SIGN_IN_SECTION_ID } })}
                source={source}
                written={written}
                asked={asked}
              />
            )
          }
        ]
      : [];
  const typeTools = editing && offer ? typeToolsToApprove(offer, asset.config) : [];
  // What agents may do with the Connection, and the way to more of it.
  const main: PageSection[] =
    read.status === "failed"
      ? []
      : [
          {
            id: "operations",
            label: t("connectionPage.agentsMayTitle"),
            count: detail?.operations.length,
            body: detail ? (
              editing ? (
                <EditableOperations
                  asset={asset}
                  frame={editing}
                  {...(offer === undefined ? {} : { exposures: offer.exposures })}
                  operations={detail.operations}
                  written={written}
                />
              ) : (
                <ConnectionOperations operations={detail.operations} config={config} />
              )
            ) : (
              <SkeletonList rows={3} />
            )
          },
          ...(editing && config.connectorType === "http_api"
            ? [
                {
                  id: "add-tools",
                  label: t("connectionCreate.addHeading"),
                  description: t("connectionCreate.addText"),
                  body: (
                    <RestToolsSection
                      asset={asset}
                      frame={editing}
                      source={source}
                      written={written}
                    />
                  )
                }
              ]
            : editing && offer && typeTools.length > 0
              ? [
                  {
                    id: "type-tools",
                    label: t("connections.typeToolsTitle"),
                    description: t("connections.typeToolsDescription"),
                    count: typeTools.length,
                    body: (
                      <TypeTools asset={asset} frame={editing} offer={offer} written={written} />
                    )
                  }
                ]
              : discoveredOpen
                ? discovered
                : [])
        ];
  // What is set once and read seldom, folded under Settings.
  const settings: PageSection[] = [
    ...(editing
      ? [
          {
            id: "about",
            label: t("connectionPage.aboutTitle"),
            description: t("connectionPage.aboutDescription"),
            body: <ConnectionAboutEditor asset={asset} frame={editing} written={written} />
          }
        ]
      : []),
    // The test of a Connection that signs in: its sign-in says first whether it works.
    ...(signInBody
      ? [
          {
            id: "status",
            label: t("connections.statusTitle"),
            description: t("connections.statusDescription"),
            body: status
          }
        ]
      : []),
    ...(detail?.oauth && personal && showsPeople(config, mayChange)
      ? [
          {
            id: "people",
            label: t("personalConnections.peopleTitle"),
            description: t("personalConnections.peopleDescription"),
            body: (
              <ConnectionPeopleSection
                name={asset.name}
                mayWrite
                adminConsentUrl={detail.oauth.adminConsentUrl}
              />
            )
          }
        ]
      : []),
    ...(detail?.testCredential
      ? [
          {
            id: "test-credential",
            label: t("connections.testCredentialTitle"),
            description: t("connections.testCredentialDescription"),
            body: (
              <ConnectionTestCredentialSection
                name={asset.name}
                revision={asset.revision}
                testCredential={detail.testCredential}
                source={source}
                mayWrite={mayChange}
                written={written}
              />
            )
          }
        ]
      : []),
    {
      id: "settings",
      label: t("connectionPage.reachTitle"),
      description: t("connectionPage.reachDescription"),
      body: (
        <>
          {signsIn ? <CredentialModeField value={credentialModeOf(config)} /> : null}
          {editing && formEdits ? (
            <ConnectionSettingsEditor
              asset={asset}
              frame={editing}
              written={written}
              view={<ConnectionSettings config={config} offer={offer} withDescription={false} />}
              {...(detail?.secret.state === "set" ? { keyUsers: detail } : {})}
            />
          ) : (
            <ConnectionSettings config={config} offer={offer} />
          )}
        </>
      )
    },
    ...(personContextHeader && personContext
      ? [
          {
            id: "person-context",
            label: t("connections.personContextTitle"),
            description: t("connections.personContextDescription"),
            body: (
              <PersonContextSection
                name={asset.name}
                header={personContextHeader}
                mappings={personContext}
              />
            )
          }
        ]
      : []),
    ...(read.status === "failed"
      ? []
      : [
          ...(discoveredOpen || config.connectorType === "http_api" || typeTools.length > 0
            ? []
            : discovered),
          {
            id: "agents",
            label: t("connections.agentsTitle"),
            description: t("connectionPage.usedByDescription"),
            count: detail ? usedByCount(detail) : undefined,
            body: detail ? <ConnectionUsedBy detail={detail} /> : <SkeletonList rows={2} />
          }
        ]),
    ...(availability
      ? [
          {
            id: AVAILABILITY_SECTION_ID,
            label: t("configAvailability"),
            description: t("configAvailabilityConnectionDescription"),
            body: availability
          }
        ]
      : []),
    // Who may use the Connection is read under the right that reads this page.
    ...(holders.status === "hidden"
      ? []
      : [
          {
            id: "access",
            label: t("connections.accessTitle"),
            description: t("connections.accessDescription"),
            count:
              holders.status === "ready"
                ? holders.access.roles.length + holders.access.holders.length
                : undefined,
            body: <ConnectionHolders read={holders} principalHref={source.principalHref} />
          }
        ])
  ];
  const users = detail ? usedByNames(detail, t) : [];
  const section = ({ id, label, description, count, body }: PageSection) => (
    <Section
      key={id}
      id={id}
      layout="stacked"
      title={label}
      description={description}
      count={count}
    >
      {body}
    </Section>
  );
  // A link of the page to a folded section unfolds Settings first, then shows the section.
  const contentRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reveal, setReveal] = useState<string>();
  useEffect(() => {
    if (reveal === undefined) return;
    scrollToSection(contentRef.current, reveal);
    setReveal(undefined);
  }, [reveal]);

  return (
    <Page
      width="narrow"
      ref={page.ref}
      header={
        <PageHeader
          variant="detail"
          back={back}
          title={title}
          state={
            // An enabled Connection is as good as its last test or call, as its status says;
            // until its detail is read, the head claims nothing about it.
            !enabled ? (
              <Badge tone="neutral" dot>
                {t("connections.disabled")}
              </Badge>
            ) : // A Connection that signs in says how it is by its sign-in, first on the page: the
            // head does not say beside it that nobody has tested it.
            headHealth && !(signInBody && headHealth === "never_tested") ? (
              <Badge
                tone={HEALTH_VIEWS[headHealth].tone}
                dot
                data-connection-head-health={headHealth}
              >
                {t(HEALTH_VIEWS[headHealth].label)}
              </Badge>
            ) : undefined
          }
          {...actions}
        />
      }
    >
      {page.above}
      <div ref={contentRef} className="grid min-w-0 content-start pt-5">
        {/* The content column has the page's gutter already. */}
        <PageLead className="px-0 pt-0 pb-3" data-asset-lead="">
          {t("connectionPage.lead", { service: title })}
        </PageLead>
        <div
          // The chip that says no agent can use it leads to "Available in", under Settings.
          onClickCapture={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest(`a[href="#${AVAILABILITY_SECTION_ID}"]`)
            ) {
              event.preventDefault();
              event.stopPropagation();
              setSettingsOpen(true);
              setReveal(AVAILABILITY_SECTION_ID);
            }
          }}
        >
          <AssetPlaceRow>
            <AssetPlaceLine
              owner={asset.scope}
              audience={audience?.text}
              {...(audience?.nowhere && availability
                ? { audienceTo: AVAILABILITY_SECTION_ID }
                : {})}
            />
          </AssetPlaceRow>
        </div>
        {notice ? <div className="mb-4 grid gap-2">{notice}</div> : null}
        {config.origin === "release" ? (
          <Banner layout="line" className="mb-4" data-build-read-only="">
            {t("connections.releaseNotice")}
          </Banner>
        ) : null}
        {editing && update ? (
          <div className="mb-4">
            <ConnectionCatalogueUpdate update={update} frame={editing} written={written} />
          </div>
        ) : null}
        {/* Spaced as a section is, with the hairline to the next one. */}
        <div
          id={signInBody ? SIGN_IN_SECTION_ID : "status"}
          className="grid min-w-0 gap-4 border-b pt-2 pb-6"
          data-connection-state=""
        >
          {enabled ? null : (
            <Banner tone="warning" data-connection-disabled="">
              {t("connections.disabledNotice")}
            </Banner>
          )}
          {signInBody ?? status}
        </div>
        {main.map(section)}
        {users.length === 0 ? null : (
          <p className="pb-6 text-body text-muted-foreground" data-connection-used-by-line="">
            {t("connectionPage.usedByLine", {
              names: new Intl.ListFormat(locale, { type: "conjunction" }).format(users)
            })}
          </p>
        )}
        <Disclosure
          variant="row"
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          data-asset-settings=""
        >
          <DisclosureTrigger data-asset-settings-trigger="">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-title-sm text-foreground">
                {t("connectionPage.settingsTitle")}
              </span>
              <span className="text-caption">{t("connectionPage.settingsHint")}</span>
            </span>
          </DisclosureTrigger>
          {/* Kept in the page while folded: what it reads is read once, and a section in it is
              found by its id. */}
          <DisclosureContent keepMounted>{settings.map(section)}</DisclosureContent>
        </Disclosure>
      </div>
    </Page>
  );
}

/** The settings a person reads by a name in words. Any other keeps its key. */
const SETTING_LABELS = new Map<string, TranslationKey>([
  ["url", "connections.url"],
  ["baseUrl", "connectionCreate.baseUrl"],
  ["testPath", "connectionCreate.testPath"],
  ["headerName", "connections.headerName"],
  ["headers", "connectionCreate.headers"],
  ["personContextHeader", "connectionCreate.personContextHeader"],
  ["oauth", "connectionCreate.oauthSettings"]
]);

/**
 * What the definition says of how the Connection reaches its system, in words: its type, how
 * it signs in, and each setting that has a name in words and one line of text. A setting
 * without such a name, a value that is a structure, and the ids of the type and the
 * authentication stand under Technical details. No setting is a credential.
 */
function ConnectionSettings({
  config,
  withDescription = true,
  offer
}: {
  config: Record<string, unknown>;
  /** The type's own form, where it has one: its title names the type. */
  offer?: ConnectorTypeOffer | undefined;
  /** Without it the description stands in its own section, where it is changed. */
  withDescription?: boolean;
}) {
  const { locale, t } = useTranslation();
  const description = withDescription ? textOf(config, "description") : undefined;
  const connectorType = textOf(config, "connectorType") ?? "";
  const authScheme = textOf(config, "authScheme") ?? "";
  const settings = settingsOf(config);
  const inWords = (entry: [string, unknown]): entry is [string, string] =>
    SETTING_LABELS.has(entry[0]) && typeof entry[1] === "string";
  const technical = settings.filter((entry) => !inWords(entry));
  return (
    <div className="grid min-w-0 gap-3">
      <KeyValueList>
        <KeyValue label={t("connections.connectorType")}>
          {offer ? offerText(offer.title, locale) : connectorTypeLabel(connectorType, t)}
        </KeyValue>
        <KeyValue label={t("connections.authScheme")}>{authSchemeLabel(authScheme, t)}</KeyValue>
        {description ? (
          <KeyValue label={t("connections.descriptionLabel")} foldable>
            {description}
          </KeyValue>
        ) : null}
        {settings.filter(inWords).map(([key, value]) => {
          const label = SETTING_LABELS.get(key);
          return (
            <KeyValue key={key} label={label === undefined ? key : t(label)}>
              <span className="break-all">{value}</span>
            </KeyValue>
          );
        })}
      </KeyValueList>
      <Disclosure data-connection-technical="">
        <DisclosureTrigger>{t("connectionCreate.details")}</DisclosureTrigger>
        <DisclosureContent>
          <KeyValueList>
            {Object.entries({ connectorType, authScheme }).map(([key, value]) => (
              <KeyValue key={key} label={<code className="font-mono">{key}</code>}>
                <code className="font-mono text-code">{value}</code>
              </KeyValue>
            ))}
            {technical.map(([key, value]) => {
              const label = SETTING_LABELS.get(key);
              return (
                <KeyValue
                  key={key}
                  label={label === undefined ? <code className="font-mono">{key}</code> : t(label)}
                >
                  <code className="font-mono text-code break-all">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </code>
                </KeyValue>
              );
            })}
          </KeyValueList>
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}

/**
 * Who may use the Connection (CONN-WHO-1): the roles first, then each person, group and service
 * principal with a right of its own, each with the verbs of what it may do. A person is a round
 * avatar; a role, a group and a service principal are square ones that say what they are in
 * words, and a service principal opens its own page. A reader who manages no users sees the
 * built-in roles and a line that says who sees the rest, never a name or a count of it.
 */
function ConnectionHolders({
  read,
  principalHref
}: {
  read: Exclude<ConnectionHoldersRead, { status: "hidden" }>;
  principalHref(principalId: string): string;
}) {
  const { t } = useTranslation();
  if (read.status === "loading") {
    return <SkeletonList rows={2} />;
  }
  if (read.status === "failed") {
    return (
      <InlineError className="flex flex-wrap items-center justify-between gap-2">
        <span>{t("connections.accessFailed")}</span>
        <Button variant="outline" size="sm" onClick={read.retry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }
  const { roles, holders, holdersShown } = read.access;
  // Only a reader who is shown everybody can be told that nobody holds a right.
  if (holdersShown && roles.length + holders.length === 0) {
    return <EmptyState layout="inline">{t("connections.accessEmpty")}</EmptyState>;
  }
  const verbs = (list: readonly RightVerb[]) => list.map((verb) => verbLabel(verb, t)).join(", ");
  return (
    <div className="flex flex-col gap-2">
      <List aria-label={t("connections.accessTitle")}>
        {roles.map((role) => {
          const label = roleLabelKey(role.id);
          const name = role.builtIn && label ? t(label) : role.name;
          return (
            <ListRow
              key={`role:${role.id}`}
              data-holder-kind="role"
              leading={
                <Avatar
                  kind="workspace"
                  size="sm"
                  name={name}
                  icon={<Shield aria-hidden="true" />}
                />
              }
              title={name}
              description={verbs(role.verbs)}
              chips={<Chip size="sm">{t("connections.accessRole")}</Chip>}
            />
          );
        })}
        {holders.map((holder) => {
          const key = `${holder.kind}:${holder.id}`;
          if (holder.kind === "user") {
            return (
              <ListRow
                key={key}
                data-holder-kind="person"
                leading={<Avatar kind="person" size="sm" name={holder.title} />}
                title={holder.title}
                description={verbs(holder.verbs)}
              />
            );
          }
          if (holder.kind === "group") {
            return (
              <ListRow
                key={key}
                data-holder-kind="group"
                leading={
                  <Avatar
                    kind="workspace"
                    size="sm"
                    name={holder.title}
                    icon={<Users aria-hidden="true" />}
                  />
                }
                title={holder.title}
                description={verbs(holder.verbs)}
                chips={<Chip size="sm">{t("connections.accessGroup")}</Chip>}
              />
            );
          }
          return (
            <ListRow
              key={key}
              data-holder-kind="service_principal"
              leading={
                <Avatar
                  kind="service"
                  size="sm"
                  name={holder.title}
                  icon={<KeyRound aria-hidden="true" />}
                />
              }
              title={holder.title}
              description={verbs(holder.verbs)}
              chips={
                <>
                  <Chip size="sm">{t("connections.accessServicePrincipal")}</Chip>
                  {holder.disabled ? (
                    <Badge tone="neutral" size="sm">
                      {t("connections.accessPrincipalDisabled")}
                    </Badge>
                  ) : null}
                </>
              }
              link={<a href={principalHref(holder.id)} />}
            />
          );
        })}
      </List>
      {holdersShown ? null : (
        <p className="text-caption text-muted-foreground" data-holders-not-shown="">
          {t("connections.accessHoldersNotShown")}
        </p>
      )}
    </div>
  );
}
