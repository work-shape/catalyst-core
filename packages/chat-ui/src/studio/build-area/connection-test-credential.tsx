import { useState } from "react";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  Field,
  FormNotice,
  Input,
  KeyValue,
  KeyValueList,
  type BadgeTone
} from "@work-shape/catalyst-ui";
import { formatDateTime } from "../../shared/locale-format";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { instanceSentence } from "./build-refusals";
import type { ActionNotice } from "./build-model";
import type { ConnectionSource } from "./connection-source";

// The section "Test credential" of a shared Connection's page (ADR-0031, DT-3): whether one is
// set, for which test account and address, and who set it when. A person who may change the
// Connection sets, rotates and removes it here. The value is entered once and never shown.

type TestCredential = NonNullable<ConnectionDetail["testCredential"]>;

const STATES: Record<TestCredential["state"], { tone: BadgeTone; label: TranslationKey }> = {
  set: { tone: "success", label: "connections.testCredentialStateSet" },
  stale: { tone: "warning", label: "connections.testCredentialStateStale" },
  not_set: { tone: "neutral", label: "connections.testCredentialStateNotSet" }
};

interface Draft {
  value: string;
  endpoint: string;
  account: string;
}

export function ConnectionTestCredentialSection({
  name,
  revision,
  testCredential,
  source,
  mayWrite,
  written
}: {
  name: string;
  /** The revision of the Connection the page shows: the credential is for its addresses. */
  revision: number;
  testCredential: TestCredential;
  source: ConnectionSource;
  /** The reader may change the Connection: the section offers the writes. */
  mayWrite: boolean;
  /** Hears of a write that landed: the page reads the Connection again. */
  written(): void;
}) {
  const { locale, t } = useTranslation();
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ActionNotice>();
  const setBy = source.usePersonName?.(testCredential.setBy);
  const view = STATES[testCredential.state];
  const present = testCredential.state !== "not_set";
  // A source that cannot write the test credential offers no write.
  const writes =
    mayWrite && source.setTestCredential && source.removeTestCredential
      ? {
          set: source.setTestCredential.bind(source),
          remove: source.removeTestCredential.bind(source)
        }
      : undefined;
  const fail = (fallback: TranslationKey) => (error: unknown) =>
    setResult({ tone: "error", text: instanceSentence(error, t) ?? t(fallback) });

  return (
    <div className="grid min-w-0 gap-4" data-connection-test-credential="">
      <KeyValueList>
        <KeyValue label={t("connections.testCredentialState")}>
          <Badge tone={view.tone} dot data-test-credential-state={testCredential.state}>
            {t(view.label)}
          </Badge>
        </KeyValue>
        {present && testCredential.account ? (
          <KeyValue label={t("connections.testCredentialAccount")}>
            {testCredential.account}
          </KeyValue>
        ) : null}
        {present && testCredential.endpoint ? (
          <KeyValue label={t("connections.testCredentialEndpoint")}>
            <code className="font-mono text-code break-all">{testCredential.endpoint}</code>
          </KeyValue>
        ) : null}
        {present && testCredential.setAt ? (
          <KeyValue label={t("connections.testCredentialSetAt")}>
            {setBy
              ? t("connections.testCredentialSetBy", {
                  time: formatDateTime(testCredential.setAt, locale),
                  name: setBy
                })
              : formatDateTime(testCredential.setAt, locale)}
          </KeyValue>
        ) : null}
      </KeyValueList>
      {testCredential.state === "stale" ? (
        <Banner tone="warning" data-test-credential-stale="">
          {t("connections.testCredentialStaleNotice")}
        </Banner>
      ) : null}
      {!writes ? null : draft === undefined ? (
        <div className="grid justify-items-start gap-1">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              data-test-credential-open=""
              onClick={() => {
                setResult(undefined);
                setDraft({
                  value: "",
                  endpoint: testCredential.endpoint ?? "",
                  account: testCredential.account ?? ""
                });
              }}
            >
              {t(present ? "connections.testCredentialReplace" : "connections.testCredentialEnter")}
            </Button>
            {present ? (
              <Button
                variant="outline"
                size="sm"
                data-test-credential-remove=""
                onClick={() => {
                  setResult(undefined);
                  setConfirming(true);
                }}
              >
                {t("connections.testCredentialRemove")}
              </Button>
            ) : null}
          </div>
          {result ? <FormNotice tone={result.tone}>{result.text}</FormNotice> : null}
        </div>
      ) : (
        <form
          className="grid w-full gap-2"
          data-test-credential-form=""
          onSubmit={(event) => {
            event.preventDefault();
            setSaving(true);
            setResult(undefined);
            writes
              .set(name, {
                value: draft.value,
                ...(draft.endpoint.trim() === "" ? {} : { endpoint: draft.endpoint.trim() }),
                ...(draft.account.trim() === "" ? {} : { account: draft.account.trim() }),
                expectedVersion: testCredential.version ?? null,
                expectedRevision: revision
              })
              .then(() => {
                setDraft(undefined);
                setResult({ tone: "success", text: t("connections.testCredentialSaved") });
                written();
              }, fail("connections.testCredentialFailed"))
              .finally(() => setSaving(false));
          }}
        >
          <Field
            label={t("connections.testCredentialValue")}
            hint={t("connections.testCredentialValueHint")}
          >
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={draft.value}
              data-test-credential-field="value"
              onChange={(event) => setDraft({ ...draft, value: event.target.value })}
            />
          </Field>
          <Field
            label={t("connections.testCredentialAccount")}
            hint={t("connections.testCredentialAccountHint")}
          >
            <Input
              value={draft.account}
              maxLength={200}
              data-test-credential-field="account"
              onChange={(event) => setDraft({ ...draft, account: event.target.value })}
            />
          </Field>
          {testCredential.takesEndpoint ? (
            <Field
              label={t("connections.testCredentialEndpoint")}
              hint={t("connections.testCredentialEndpointHint")}
            >
              <Input
                type="url"
                spellCheck={false}
                value={draft.endpoint}
                data-test-credential-field="endpoint"
                onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
              />
            </Field>
          ) : null}
          {result?.tone === "error" ? <FormNotice tone="error">{result.text}</FormNotice> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={saving} disabled={draft.value === ""}>
              {t("connections.testCredentialSave")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDraft(undefined)}>
              {t("connections.secretCancel")}
            </Button>
          </div>
        </form>
      )}
      {writes && present ? (
        <ConfirmDialog
          open={confirming}
          title={t("connections.testCredentialRemoveTitle")}
          confirmLabel={t("connections.testCredentialRemove")}
          loading={removing}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setRemoving(true);
            writes
              .remove(name)
              .then(() => {
                setConfirming(false);
                setResult({ tone: "success", text: t("connections.testCredentialRemoved") });
                written();
              }, fail("connections.testCredentialRemoveFailed"))
              .finally(() => setRemoving(false));
          }}
        >
          {t("connections.testCredentialRemoveBody")}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
