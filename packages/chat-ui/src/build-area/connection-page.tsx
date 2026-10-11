import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import {
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
  Section,
  SkeletonList,
  SubRail,
  type BadgeTone
} from "@vivd-catalyst/ui";
import type {
  ConnectionDetail,
  ConnectionOperationDetail,
  ConnectionOperationExposure,
  ConnectionOperationStatus,
  ConnectionTestStatus
} from "../api/connections-client";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation, type TranslationKey } from "../i18n";
import { agentKind } from "./agent-kind";
import { usePageShown } from "./asset-editor-shell";
import type { BuildAssetViewProps } from "./build-asset-kind";
import { useBuildNavigation } from "./build-route";
import type { ConnectionSource, ConnectionTestRun } from "./connection-source";

/** What the Status section says of a Connection: one word and one sentence each. */
type HealthView =
  | "testing"
  | "ready"
  | "unauthorized"
  | "network_denied"
  | "unavailable"
  | "not_configured"
  | "secret_unreadable"
  | "never_tested";

const HEALTH_VIEWS: Record<
  HealthView,
  { tone: BadgeTone; label: TranslationKey; text: TranslationKey }
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
    text: "connections.healthUnauthorizedText"
  },
  network_denied: {
    tone: "danger",
    label: "connections.healthNetworkDenied",
    text: "connections.healthNetworkDeniedText"
  },
  unavailable: {
    tone: "danger",
    label: "connections.healthUnavailable",
    text: "connections.healthUnavailableText"
  },
  not_configured: {
    tone: "warning",
    label: "connections.healthNotConfigured",
    text: "connections.healthNotConfiguredText"
  },
  secret_unreadable: {
    tone: "danger",
    label: "connections.healthSecretUnreadable",
    text: "connections.healthSecretUnreadableText"
  },
  never_tested: {
    tone: "neutral",
    label: "connections.healthNeverTested",
    text: "connections.healthNeverTestedText"
  }
};

/** The reasons a failed test or call records, as far as the page tells them apart. */
const RECORDED_FAILURES: Record<string, HealthView> = {
  upstream_unauthorized: "unauthorized",
  egress_denied: "network_denied"
};

const TEST_RESULTS: Record<ConnectionTestStatus, HealthView> = {
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
      return RECORDED_FAILURES[detail.lastErrorCode ?? ""] ?? "unavailable";
    case "unknown":
      return "never_tested";
  }
}

/**
 * What the page says: a running test first, then the answer of the test just run, then what
 * the instance recorded. A test that only found the Connection unavailable does not hide the
 * recorded reason for it, a missing or unreadable credential.
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
  return tested === "unavailable" &&
    (recorded === "not_configured" || recorded === "secret_unreadable")
    ? recorded
    : tested;
}

const OPERATION_STATUS: Record<
  ConnectionOperationStatus,
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

const EXPOSURE_LABELS: Record<ConnectionOperationExposure, TranslationKey> = {
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
 * Connection belongs to and that release config defines it, its status with the test, its
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
      description: t("connections.definedInReleaseDescription"),
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
        ])
  ];

  return (
    <Page
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
            <>
              {config.origin === "release" ? (
                <Chip lockLabel={t("build.readOnly")}>{t("connections.definedInRelease")}</Chip>
              ) : null}
              <Badge tone={enabled ? "success" : "neutral"} dot>
                {t(enabled ? "connections.enabled" : "connections.disabled")}
              </Badge>
            </>
          }
          description={
            <span className="flex min-w-0 items-center gap-2">
              <span>{t("connections.kindSingular")}</span>
              <code className="min-w-0 truncate text-code" title={asset.name}>
                {asset.name}
              </code>
            </span>
          }
        />
      }
      subRail={
        <SubRail
          mode="anchors"
          belowHeader
          label={t("build.sections")}
          groups={[
            {
              id: "sections",
              items: sections.map(({ id, label, count }) => ({ id, label, count }))
            }
          ]}
        />
      }
    >
      {page.above}
      {/* The first line of the content starts where the first item of the index does. */}
      <div className="grid min-w-0 content-start pt-5">
        {sections.map((section) => (
          <Section
            key={section.id}
            id={section.id}
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
  source,
  mayTest
}: {
  name: string;
  detail: ConnectionDetail;
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
          </div>
        </KeyValue>
      </KeyValueList>
      {detail.sharedCredential ? (
        <Banner
          tone="warning"
          title={t("connections.sharedAccountTitle")}
          data-connection-shared=""
        >
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
