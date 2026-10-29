// @rights-screen: included in the rights wording guard.
import { KeyRound, Shield, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
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
  PageOutline,
  Section,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { roleLabelKey } from "../../admin/access/role-model";
import { verbLabel, type RightVerb } from "../../admin/access/right-words";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { usePageShown } from "./asset-editor-shell";
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
  DiscoveredTools
} from "./connection-editing";
import {
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
import { ConnectionUsedBy, usedByCount } from "./connection-used-by";
import {
  AUTH_SCHEME_NONE,
  ConnectionStatus,
  HEALTH_VIEWS,
  recordedHealth
} from "./connection-status";
import { withOAuthSettings } from "./connection-sign-in-model";
import type { ConnectionHoldersRead, ConnectionSource } from "./connection-source";

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

/**
 * The page of one Connection: the header with whom the Connection belongs to, where it comes
 * from, its status with the test, its settings, its operations and the agents that carry
 * them. Of the credential it shows whether it is there. It reads the named members of the
 * definition only, so a reference to the credential in the revision is never on the page.
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
  const [wait, setWait] = useState<DiscoveryWait | undefined>(() =>
    editing && discovers ? { since: Date.now() } : undefined
  );
  const read = source.useDetail(asset.name, wait);
  const holders = source.useHolders(asset.name);
  const detail = read.status === "ready" ? read.detail : undefined;
  const waiting =
    wait !== undefined && detail !== undefined && waitsForDiscovery(wait, detail, Date.now());
  const written = () => setWait({ since: Date.now(), discoveredAt: detail?.discoveredAt });
  const { config } = asset;
  const runtime = config.origin !== "release";
  const title = textOf(config, "displayName") ?? asset.name;
  const enabled = config.enabled !== false;
  const headHealth = detail ? recordedHealth(detail) : undefined;
  const personContextHeader = personContextHeaderOf(config);
  // The mappings are admin data: only a reader who may change the Connection reads them.
  const personContext = source.mayTest(asset) ? source.personContext : undefined;
  // Each person connects their own account: the page's sign-in is the reader's own.
  const personal = isPersonalConfig(config);
  const signsIn = textOf(config, "authScheme") === "oauth";
  const sections: {
    id: string;
    label: string;
    description: string;
    count?: number;
    body: ReactNode;
  }[] = [
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
    {
      id: "status",
      label: t("connections.statusTitle"),
      description: t("connections.statusDescription"),
      body: (
        <>
          {enabled ? null : (
            <Banner tone="warning" data-connection-disabled="">
              {t("connections.disabledNotice")}
            </Banner>
          )}
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
              mayTest={source.mayTest(asset)}
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
      )
    },
    ...(detail?.oauth && personal
      ? [
          {
            id: "sign-in",
            label: t("connectionSignIn.sectionTitle"),
            description: t("personalConnections.sectionDescription"),
            body: <PersonalSignInSection name={asset.name} title={title} />
          },
          ...(showsPeople(config, source.mayTest(asset))
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
            : [])
        ]
      : detail?.oauth
        ? [
            {
              id: "sign-in",
              label: t("connectionSignIn.sectionTitle"),
              description: t("connectionSignIn.sectionDescription"),
              body: (
                <ConnectionSignInSection
                  asset={asset}
                  detail={detail}
                  source={source}
                  mayWrite={source.mayTest(asset)}
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
              )
            }
          ]
        : []),
    {
      id: "settings",
      label: t("connections.settingsTitle"),
      description: t("connections.settingsDescription"),
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
          {
            id: "operations",
            label: t("connections.operationsTitle"),
            description: t("connections.operationsDescription"),
            count: detail?.operations.length,
            body: detail ? (
              editing ? (
                <EditableOperations
                  asset={asset}
                  frame={editing}
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
            : editing && discovers
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
                        source={source}
                        written={written}
                      />
                    )
                  }
                ]
              : []),
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

  return (
    <Page
      width="narrow"
      ref={page.ref}
      header={
        <PageHeader
          variant="detail"
          back={back}
          title={title}
          description={textOf(config, "description")}
          state={
            // An enabled Connection is as good as its last test or call, as its status says;
            // until its detail is read, the head claims nothing about it.
            !enabled ? (
              <Badge tone="neutral" dot>
                {t("connections.disabled")}
              </Badge>
            ) : headHealth ? (
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
      outline={
        <PageOutline
          belowHeader
          items={sections.map(({ id, label, count }) => ({ id, label, count }))}
        />
      }
    >
      {page.above}
      {/* The first line of the content starts where the outline does. */}
      <div className="grid min-w-0 content-start pt-5">
        <AssetPlaceRow>
          <AssetPlaceLine
            owner={asset.scope}
            audience={audience?.text}
            {...(audience?.nowhere && availability ? { audienceTo: AVAILABILITY_SECTION_ID } : {})}
          />
        </AssetPlaceRow>
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
        {sections.map((section) => (
          <Section
            key={section.id}
            id={section.id}
            layout="stacked"
            title={section.label}
            description={section.description}
            count={section.count}
          >
            {section.body}
          </Section>
        ))}
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
 * What the definition says of how the Connection reaches its system, in words. The ids of its
 * type and its authentication stand under Technical details. No setting is a credential.
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
        {settingsOf(config).map(([key, value]) => {
          const label = SETTING_LABELS.get(key);
          return (
            <KeyValue
              key={key}
              label={label === undefined ? <code className="font-mono">{key}</code> : t(label)}
            >
              <code className="font-mono text-code">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </code>
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
