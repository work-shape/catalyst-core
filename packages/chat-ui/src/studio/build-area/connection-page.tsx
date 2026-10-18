// @rights-screen: included in the rights wording guard.
import { Bot, KeyRound } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Chip,
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
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { useTranslation } from "../../shared/i18n";
import { agentKind } from "./agent-kind";
import { usePageShown } from "./asset-editor-shell";
import type {
  BuildAssetEditorProps,
  BuildAssetViewProps,
  BuildHeadActions
} from "./build-asset-kind";
import { useBuildNavigation } from "../../shared/build-route";
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
import { ConnectionOperations, EditableOperations } from "./connection-operations";
import { PersonContextSection } from "./connection-person-context";
import { RestToolsSection } from "./connection-rest-tools";
import { ConnectionSignInSection } from "./connection-sign-in-section";
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
  editing
}: Omit<BuildAssetViewProps, "kinds"> & {
  /** The frame's actions for the head: History, and Delete where the reader may delete. */
  actions?: BuildHeadActions;
  /** What the frame says above the content, such as a conflict. */
  notice?: ReactNode;
  source: ConnectionSource;
  editing?: BuildAssetEditorProps;
}) {
  const { t } = useTranslation();
  usePageShown(page, "asset");
  // A Connection made here and not yet read waits for its first discovery. A REST API has none:
  // its page reads the Connection again for a while after a write.
  const [wait, setWait] = useState<DiscoveryWait | undefined>(() =>
    editing && asset.config.connectorType !== "http_api" ? { since: Date.now() } : undefined
  );
  const read = source.useDetail(asset.name, wait);
  const holders = source.useHolders(asset.id);
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
  const sections: {
    id: string;
    label: string;
    description: string;
    count?: number;
    body: ReactNode;
  }[] = [
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
                        secret={read.detail.secret}
                        source={source}
                        written={written}
                        {...(retest ? { retest } : {})}
                        removal={{ frame: editing, config, usedBy: read.detail.usedBy }}
                      />
                    )
                  : undefined
              }
            />
          )}
        </>
      )
    },
    ...(detail?.oauth
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
                        if (!outcome.ok) throw new Error("The sign-in settings were not saved");
                        written();
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
      body: editing ? (
        <ConnectionSettingsEditor
          asset={asset}
          frame={editing}
          written={written}
          view={<ConnectionSettings config={config} />}
          {...(detail?.secret.state === "set" ? { keyUsers: detail.usedBy } : {})}
        />
      ) : (
        <ConnectionSettings config={config} />
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
                <ConnectionOperations operations={detail.operations} />
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
            : editing
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
            description: t("connections.agentsDescription"),
            count: detail?.usedBy.length,
            body: detail ? <ConnectionAgents usedBy={detail.usedBy} /> : <SkeletonList rows={2} />
          }
        ]),
    // Who was given this Connection is shown to who is shown rights at all.
    ...(holders.status === "hidden"
      ? []
      : [
          {
            id: "access",
            label: t("connections.accessTitle"),
            description: t("connections.accessDescription"),
            count: holders.status === "ready" ? holders.holders.length : undefined,
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
          scope={
            <Chip>
              {t(
                asset.scope.kind === "workspace"
                  ? "connections.scopeWorkspace"
                  : "connections.scopeInstance"
              )}
            </Chip>
          }
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
        {notice ? <div className="mb-4 grid gap-2">{notice}</div> : null}
        {config.origin === "release" ? (
          <Banner layout="line" className="mb-4" data-build-read-only="">
            {t("connections.releaseNotice")}
          </Banner>
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

/** What the definition says of how the Connection reaches its system. No setting is a credential. */
function ConnectionSettings({ config }: { config: Record<string, unknown> }) {
  const { t } = useTranslation();
  const description = textOf(config, "description");
  return (
    <KeyValueList>
      <KeyValue label={t("connections.connectorType")}>
        <code className="font-mono text-code">{textOf(config, "connectorType")}</code>
      </KeyValue>
      <KeyValue label={t("connections.authScheme")}>
        <code className="font-mono text-code">{textOf(config, "authScheme")}</code>
      </KeyValue>
      {description ? (
        <KeyValue label={t("connections.descriptionLabel")} foldable>
          {description}
        </KeyValue>
      ) : null}
      {settingsOf(config).map(([key, value]) => (
        <KeyValue
          key={key}
          label={
            // This key is too long for the label column; its human label wraps.
            key === "personContextHeader" ? (
              t("connectionCreate.personContextHeader")
            ) : (
              <code className="font-mono">{key}</code>
            )
          }
        >
          <code className="font-mono text-code">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </code>
        </KeyValue>
      ))}
    </KeyValueList>
  );
}

/**
 * The people and the service principals that were given this Connection by itself. A person is
 * a round avatar with an address; a service principal is a square one with a key, says what it
 * is in words, and opens its own page. Neither is named by an id.
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
  if (read.holders.length === 0) {
    return <EmptyState layout="inline">{t("connections.accessEmpty")}</EmptyState>;
  }
  return (
    <List aria-label={t("connections.accessTitle")}>
      {read.holders.map((holder) => {
        if (holder.kind === "person") {
          const name = holder.name ?? t("connections.accessUnknownPerson");
          return (
            <ListRow
              key={holder.grantId}
              data-holder-kind="person"
              leading={<Avatar kind="person" size="sm" name={name} />}
              title={name}
              description={holder.detail}
            />
          );
        }
        const name = holder.name ?? t("connections.accessUnknownPrincipal");
        return (
          <ListRow
            key={holder.grantId}
            data-holder-kind="service_principal"
            leading={
              <Avatar kind="service" size="sm" name={name} icon={<KeyRound aria-hidden="true" />} />
            }
            title={name}
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
            link={holder.name === undefined ? undefined : <a href={principalHref(holder.id)} />}
          />
        );
      })}
    </List>
  );
}

function ConnectionAgents({ usedBy }: { usedBy: ConnectionDetail["usedBy"] }) {
  const { t } = useTranslation();
  const { href, open } = useBuildNavigation();
  if (usedBy.length === 0) {
    return <EmptyState layout="inline">{t("connections.agentsEmpty")}</EmptyState>;
  }
  return (
    <List aria-label={t("connections.agentsTitle")}>
      {usedBy.map((agent) => {
        const place = { kindPath: agentKind.path, name: agent.agentName };
        return (
          <ListRow
            key={agent.agentName}
            leading={<Bot aria-hidden="true" className="size-4 text-muted-foreground" />}
            title={agent.title.trim() || agent.agentName}
            description={<code className="font-mono">{agent.agentName}</code>}
            time={t(
              agent.toolNames.length === 1 ? "connections.agentTool" : "connections.agentTools",
              { count: agent.toolNames.length }
            )}
            link={
              <a
                href={href(place)}
                onClick={(event) => {
                  if (
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    open(place);
                  }
                }}
              />
            }
          />
        );
      })}
    </List>
  );
}
