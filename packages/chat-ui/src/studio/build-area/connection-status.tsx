// @rights-screen: included in the rights wording guard.
import type { ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  FormNotice,
  KeyValue,
  KeyValueList,
  type BadgeTone
} from "@work-shape/catalyst-ui";
import type { ConnectionDetail, ConnectionTestResult } from "@work-shape/catalyst-api-client";
import { formatDateTime } from "../../shared/locale-format";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { SignInStateBadge } from "./connection-sign-in-section";
import { needsSignIn } from "./connection-sign-in-model";
import type { ConnectionSource, ConnectionTestRun } from "./connection-source";

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
  /** The Connection signs in with OAuth, and its calls have no sign-in to use. */
  | "sign_in_needed"
  | "never_tested";

export const HEALTH_VIEWS: Record<
  HealthView,
  {
    tone: BadgeTone;
    label: TranslationKey;
    text: TranslationKey;
    next?: TranslationKey;
    /** The next step on a Connection made on the instance, where its editor takes it. */
    nextRuntime?: TranslationKey;
  }
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
    next: "connections.healthUnauthorizedNext",
    nextRuntime: "connections.healthUnauthorizedNextRuntime"
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
    next: "connections.healthUnavailableNext",
    nextRuntime: "connections.healthUnavailableNextRuntime"
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
    next: "connections.healthNotConfiguredNext",
    nextRuntime: "connections.healthNotConfiguredNextRuntime"
  },
  secret_unreadable: {
    tone: "danger",
    label: "connections.healthSecretUnreadable",
    text: "connections.healthSecretUnreadableText",
    next: "connections.healthSecretUnreadableNext",
    nextRuntime: "connections.healthSecretUnreadableNextRuntime"
  },
  sign_in_needed: {
    tone: "warning",
    label: "connections.healthSignInNeeded",
    text: "connections.healthSignInNeededText",
    next: "connections.healthSignInNeededNext"
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
  unavailable: "unavailable",
  connection_not_connected: "sign_in_needed",
  connection_needs_reconnect: "sign_in_needed"
};

/** The auth scheme of a Connection that sends no credential. */
export const AUTH_SCHEME_NONE = "none";

const TEST_RESULTS: Record<ConnectionTestResult["status"], HealthView> = {
  ready: "ready",
  unauthorized: "unauthorized",
  network_denied: "network_denied",
  unavailable: "unavailable",
  // The server asks for a sign-in, or the Connection signs in and nobody has.
  oauth_required: "sign_in_needed"
};

/** What the instance recorded, before this page's own test. */
export function recordedHealth(detail: ConnectionDetail): HealthView {
  switch (detail.health) {
    case "needs_configuration":
      return needsSignIn(detail) ? "sign_in_needed" : "not_configured";
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

/** The health with the test, the state of the credential and whose account every call uses. */
export function ConnectionStatus({
  name,
  detail,
  needsCredential,
  runtime,
  source,
  mayTest,
  credentialEditor
}: {
  name: string;
  detail: ConnectionDetail;
  /** The Connection's auth scheme sends a credential. With `none` there is none to set. */
  needsCredential: boolean;
  /** Made on the instance: the next step is taken on this page, not by the operator. */
  runtime: boolean;
  source: ConnectionSource;
  mayTest: boolean;
  /**
   * Where the reader enters the credential, for a reader who may; handed the page's test where
   * the reader may test.
   */
  credentialEditor?: (retest: (() => void) | undefined) => ReactNode;
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
          <p className="text-body">
            {t(
              // It sends no credential, so the server refused none: it wants one.
              view === "unauthorized" && !needsCredential
                ? "connections.healthUnauthorizedTextNoKey"
                : health.text
            )}
          </p>
          {health.next ? (
            <p className="text-body">
              {t(
                // A Connection that sends no key cannot take one under Credential.
                runtime && view === "unauthorized" && !needsCredential
                  ? "connections.healthUnauthorizedNextNoKey"
                  : runtime && health.nextRuntime
                    ? health.nextRuntime
                    : health.next
              )}
            </p>
          ) : null}
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
        {detail.oauth ? (
          <KeyValue label={t("connectionSignIn.sectionTitle")}>
            <SignInStateBadge binding={detail.binding} />
          </KeyValue>
        ) : (
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
                    {/* The version of the credential is for whoever may change the Connection. */}
                    {secret.state === "set"
                      ? secret.version === undefined || !mayTest
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
                  {credentialEditor?.(mayTest ? start : undefined)}
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
        )}
      </KeyValueList>
      {needsCredential && !detail.oauth && detail.sharedCredential ? (
        <Banner layout="line" title={t("connections.sharedAccountTitle")} data-connection-shared="">
          {t("connections.sharedAccountText")}
        </Banner>
      ) : null}
    </>
  );
}
