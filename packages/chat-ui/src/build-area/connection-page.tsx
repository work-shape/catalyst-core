import { Bot, KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Chip,
  EmptyState,
  FormNotice,
  InlineError,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  Page,
  PageHeader,
  PageOutline,
  Section,
  SkeletonList,
  type BadgeTone
} from "@vivd-catalyst/ui";
import type {
  ConnectionDetail,
  ConnectionOperationDetail,
  ConnectionTestResult
} from "@vivd-catalyst/api-client";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation, type TranslationKey } from "../i18n";
import { agentKind } from "./agent-kind";
import { AssetIdentifier, usePageShown } from "./asset-editor-shell";
import type { BuildAssetViewProps } from "./build-asset-kind";
import { useBuildNavigation } from "./build-route";
import type {
  ConnectionHoldersRead,
  ConnectionSource,
  ConnectionTestRun
} from "./connection-source";

/** What the Status section says of a Connection: one word and one sentence each. */
type HealthView =
  | "testing"
  | "ready"
  | "unauthorized"
  | "network_denied"
  | "unavailable"
  | "failed"
  | "not_configured"
  | "secret_unreadable"
  | "never_tested";

const HEALTH_VIEWS: Record<
  HealthView,
  { tone: BadgeTone; label: TranslationKey; text: TranslationKey; next?: TranslationKey }
> = {
  testing: {
    tone: "info",
    label: "connections.healthTesting",
    text: "connections.healthTestingText"
  },
  ready: { tone: "success", label: "connections.healthReady", text: "connections.healthReadyText" },
  unauthorized: {
    tone: "danger",
    label: "connections.healthUnauthorized",
    text: "connections.healthUnauthorizedText",
    next: "connections.healthUnauthorizedNext"
  },
  network_denied: {
    tone: "danger",
    label: "connections.healthNetworkDenied",
    text: "connections.healthNetworkDeniedText",
    next: "connections.healthNetworkDeniedNext"
  },
  unavailable: {
    tone: "danger",
    label: "connections.healthUnavailable",
    text: "connections.healthUnavailableText",
    next: "connections.healthUnavailableNext"
  },
  failed: {
    tone: "danger",
    label: "connections.healthFailed",
    text: "connections.healthFailedText",
    next: "connections.healthFailedNext"
  },
  not_configured: {
    tone: "warning",
    label: "connections.healthNotConfigured",
    text: "connections.healthNotConfiguredText",
    next: "connections.healthNotConfiguredNext"
  },
  secret_unreadable: {
    tone: "danger",
    label: "connections.healthSecretUnreadable",
    text: "connections.healthSecretUnreadableText",
    next: "connections.healthSecretUnreadableNext"
  },
  never_tested: {
    tone: "neutral",
    label: "connections.healthNeverTested",
    text: "connections.healthNeverTestedText"
  }
};

/**
 * What a failed test or call records, as far as the page tells it apart: the reason where the
 * instance has one, else the answer of the Connector type's own test.
 */
const RECORDED_FAILURES: Record<string, HealthView> = {
  upstream_unauthorized: "unauthorized",
  unauthorized: "unauthorized",
  egress_denied: "network_denied",
  network_denied: "network_denied",
  connection_unavailable: "unavailable",
  upstream_timeout: "unavailable",
  unavailable: "unavailable"
};

/** The auth scheme of a Connection that sends no credential. */
const AUTH_SCHEME_NONE = "none";

const TEST_RESULTS: Record<ConnectionTestResult["status"], HealthView> = {
  ready: "ready",
  unauthorized: "unauthorized",
  network_denied: "network_denied",
  unavailable: "unavailable"
};

/** What the instance recorded, before this page's own test. */
function recordedHealth(detail: ConnectionDetail): HealthView {
  switch (detail.health) {
    case "needs_configuration":
      return "not_configured";
    case "secret_unreadable":
      return "secret_unreadable";
    case "ok":
      return "ready";
    case "failed":
      return RECORDED_FAILURES[detail.lastErrorCode ?? ""] ?? "failed";
    case "unknown":
      return "never_tested";
  }
}

/**
 * What the page says: a running test first, then the answer of the test just run, then what
 * the instance recorded. A test that failed does not hide the recorded reason for it, a
 * missing or unreadable credential: the instance answers such a test as unauthorized.
 */
function healthOf(detail: ConnectionDetail, run: ConnectionTestRun): HealthView {
  if (run.status === "running") {
    return "testing";
  }
  const recorded = recordedHealth(detail);
  if (run.status !== "done") {
    return recorded;
  }
  const tested = TEST_RESULTS[run.result.status];
  return tested !== "ready" && (recorded === "not_configured" || recorded === "secret_unreadable")
    ? recorded
    : tested;
}

const OPERATION_STATUS: Record<
  ConnectionOperationDetail["status"],
  { tone: BadgeTone; label: TranslationKey; text?: TranslationKey }
> = {
  ready: { tone: "success", label: "connections.statusReady" },
  awaiting_discovery: {
    tone: "neutral",
    label: "connections.statusAwaitingDiscovery",
    text: "connections.statusAwaitingDiscoveryText"
  },
  needs_review: {
    tone: "warning",
    label: "connections.statusNeedsReview",
    text: "connections.statusNeedsReviewText"
  },
  unknown: {
    tone: "danger",
    label: "connections.statusUnknown",
    text: "connections.statusUnknownText"
  },
  disabled: {
    tone: "neutral",
    label: "connections.statusDisabled",
    text: "connections.statusDisabledText"
  }
};

const EXPOSURE_LABELS: Record<ConnectionOperationDetail["exposure"][number], TranslationKey> = {
  agent: "connections.exposureAgent",
  bridge: "connections.exposureBridge",
  workflow: "connections.exposureWorkflow"
};

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
 * The page of one Connection. It shows and changes nothing: the header with whom the
 * Connection belongs to, that it comes from the release config, its status with the test, its
 * settings, its operations and the agents that carry them. Of the credential it shows whether
 * it is there. It reads the named members of the definition only, so a reference to the
 * credential in the revision is never on the page.
 */
export function ConnectionPage({
  page,
  back,
  asset,
  source
}: BuildAssetViewProps & { source: ConnectionSource }) {
  const { t } = useTranslation();
  usePageShown(page, "asset");
  const read = source.useDetail(asset.name);
  const holders = source.useHolders(asset.id);
  const detail = read.status === "ready" ? read.detail : undefined;
  const { config } = asset;
  const title = textOf(config, "displayName") ?? asset.name;
  const description = textOf(config, "description");
  const enabled = config.enabled !== false;
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
          <AssetIdentifier name={asset.name} />
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
              source={source}
              mayTest={source.mayTest(asset)}
            />
          )}
        </>
      )
    },
    {
      id: "settings",
      label: t("connections.settingsTitle"),
      description: t("connections.settingsDescription"),
      body: (
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
            <KeyValue key={key} label={<code className="font-mono">{key}</code>}>
              <code className="font-mono text-code">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </code>
            </KeyValue>
          ))}
        </KeyValueList>
      )
    },
    ...(read.status === "failed"
      ? []
      : [
          {
            id: "operations",
            label: t("connections.operationsTitle"),
            description: t("connections.operationsDescription"),
            count: detail?.operations.length,
            body: detail ? (
              <ConnectionOperations operations={detail.operations} />
            ) : (
              <SkeletonList rows={3} />
            )
          },
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
            <Badge tone={enabled ? "success" : "neutral"} dot>
              {t(enabled ? "connections.enabled" : "connections.disabled")}
            </Badge>
          }
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
        {config.origin === "release" ? (
          <Banner layout="line" className="mb-4" data-build-read-only="">
            {t("connections.description")}
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

/** The health with the test, the state of the credential and whose account every call uses. */
function ConnectionStatus({
  name,
  detail,
  needsCredential,
  source,
  mayTest
}: {
  name: string;
  detail: ConnectionDetail;
  /** The Connection's auth scheme sends a credential. With `none` there is none to set. */
  needsCredential: boolean;
  source: ConnectionSource;
  mayTest: boolean;
}) {
  const { locale, t } = useTranslation();
  const { run, start } = source.useTest(name);
  const view = healthOf(detail, run);
  const health = HEALTH_VIEWS[view];
  const testedAt =
    run.status === "running"
      ? undefined
      : run.status === "done"
        ? run.result.testedAt
        : detail.lastTestedAt;
  const { secret } = detail;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div
          role="status"
          data-connection-health={view}
          className="grid min-w-0 flex-1 basis-64 gap-1.5"
        >
          <Badge tone={health.tone} dot>
            {t(health.label)}
          </Badge>
          <p className="text-body">{t(health.text)}</p>
          {health.next ? <p className="text-body">{t(health.next)}</p> : null}
          {testedAt ? (
            <p className="text-caption text-muted-foreground">
              {t("connections.lastTested", { time: formatDateTime(testedAt, locale) })}
            </p>
          ) : null}
        </div>
        {mayTest ? (
          <Button variant="outline" loading={run.status === "running"} onClick={start}>
            {t("connections.test")}
          </Button>
        ) : null}
      </div>
      {run.status === "refused" ? (
        <FormNotice tone="error">{t("connections.testRefused")}</FormNotice>
      ) : run.status === "held" ? (
        <Banner layout="line" data-connection-test-held="">
          {t("connections.testHeld")}
        </Banner>
      ) : run.status === "failed" ? (
        <FormNotice tone="error">{run.message ?? t("connections.testFailed")}</FormNotice>
      ) : mayTest ? null : (
        <Banner layout="line" data-connection-test-not-allowed="">
          {t("connections.testNotAllowed")}
        </Banner>
      )}
      <KeyValueList>
        <KeyValue label={t("connections.credential")}>
          <div className="grid justify-items-start gap-1">
            {needsCredential ? (
              <>
                <Badge
                  data-connection-credential={secret.state}
                  tone={
                    secret.state === "set"
                      ? "success"
                      : secret.state === "unreadable"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {secret.state === "set"
                    ? secret.version === undefined
                      ? t("connections.credentialSet")
                      : t("connections.credentialSetVersion", { version: secret.version })
                    : t(
                        secret.state === "unreadable"
                          ? "connections.credentialUnreadable"
                          : "connections.credentialNotSet"
                      )}
                </Badge>
                <span className="text-caption text-muted-foreground">
                  {t("connections.credentialNeverShown")}
                </span>
              </>
            ) : (
              <>
                <Badge data-connection-credential="none_needed" tone="neutral">
                  {t("connections.credentialNoneNeeded")}
                </Badge>
                <span className="text-caption text-muted-foreground">
                  {t("connections.credentialNoneNeededText")}
                </span>
              </>
            )}
          </div>
        </KeyValue>
      </KeyValueList>
      {needsCredential && detail.sharedCredential ? (
        <Banner layout="line" title={t("connections.sharedAccountTitle")} data-connection-shared="">
          {t("connections.sharedAccountText")}
        </Banner>
      ) : null}
    </>
  );
}

function ConnectionOperations({ operations }: { operations: ConnectionOperationDetail[] }) {
  const { t } = useTranslation();
  if (operations.length === 0) {
    return <EmptyState layout="inline">{t("connections.operationsEmpty")}</EmptyState>;
  }
  return (
    <List aria-label={t("connections.operationsTitle")}>
      {operations.map((operation) => {
        // An operation that is switched off is disabled, whatever the catalog says of it.
        const status = OPERATION_STATUS[operation.enabled ? operation.status : "disabled"];
        return (
          <li
            key={operation.name}
            data-connection-operation={operation.name}
            className="grid min-w-0 gap-1.5 border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <code className="min-w-0 font-mono text-code break-all">{operation.name}</code>
              <Badge tone={operation.effect === "changing" ? "warning" : "neutral"}>
                {t(
                  operation.effect === "changing"
                    ? "connections.effectChanging"
                    : "connections.effectReading"
                )}
              </Badge>
              <Badge tone={status.tone} dot className="ml-auto">
                {t(status.label)}
              </Badge>
            </div>
            <code className="font-mono text-caption break-all text-muted-foreground">
              {operation.toolName}
            </code>
            {operation.description ? (
              <p className="line-clamp-3 text-body whitespace-pre-line">{operation.description}</p>
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
              {operation.exposure.length === 0 ? (
                t("connections.exposureNone")
              ) : (
                <>
                  <span>{t("connections.operationExposure")}</span>
                  {operation.exposure.map((exposure) => (
                    <Chip key={exposure} size="sm">
                      {t(EXPOSURE_LABELS[exposure])}
                    </Chip>
                  ))}
                </>
              )}
            </div>
            {status.text ? (
              <p className="text-caption text-muted-foreground">
                {t(status.text)}
                {operation.status === "needs_review" && operation.discoveredFingerprint ? (
                  <>
                    {" "}
                    {t("connections.statusNeedsReviewFingerprint")}{" "}
                    <code className="font-mono break-all">{operation.discoveredFingerprint}</code>
                  </>
                ) : null}
              </p>
            ) : null}
          </li>
        );
      })}
    </List>
  );
}

/**
 * The people and the service principals that were given this Connection by itself. A person is
 * a round avatar with an address; a service principal is a square one with a key, says what it
 * is in words, and opens its own page.
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
            description={
              holder.detail ? <code className="font-mono">{holder.detail}</code> : undefined
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
