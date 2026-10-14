import { KeyRound } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import {
  ApiError,
  type ConfirmConnectCodeRequest,
  type ConnectCode,
  type CreatePersonalApiKeyRequest
} from "@vivd-catalyst/api-client";
import {
  Banner,
  Button,
  Dialog,
  Field,
  InlineError,
  Input,
  KeyValue,
  KeyValueList,
  PageHeader,
  Section,
  SkeletonList
} from "@vivd-catalyst/ui";
import {
  useConnectCodeQuery,
  useOwnApiKeyMutations,
  useOwnApiKeysQuery
} from "../../api/personal-api-keys";
import { usePlatformContextQuery } from "../../api/workspace-queries";
import type { RevealedSecret } from "../../control-plane/api-access-secret-fields";
import { formatDateTime } from "../../control-plane/locale-format";
import { PersonalKeyFields } from "../../control-plane/personal-api-key-fields";
import {
  PersonalApiKeysTable,
  PersonalKeyRevealDialog
} from "../../control-plane/personal-api-keys-list";
import {
  connectCodeOfSearch,
  formatConnectCode,
  initialPersonalKeyDraft,
  instanceUrl,
  isCompleteConnectCode,
  personalKeyActionOffer,
  personalKeyRequest,
  type PersonalKeyDraft
} from "../../control-plane/personal-api-keys-model";
import { useTranslation } from "../../i18n";
import { apiErrorMessage } from "../../workspace-utils";
import { useSettingsPage } from "../settings-page-context";

/** What the key fields offer: the actions and the Namespaces. */
interface KeyOffer {
  actions: string[];
  namespaces: string[];
}

/**
 * You > API keys: the person's own keys, issuing one, and confirming the connect code the CLI
 * shows. The CLI sends the person here as `?code=ABCD-EFGH`.
 */
export function ApiKeysPage() {
  const { apiBaseUrl, authScope, client, user } = useSettingsPage();
  const { t } = useTranslation();
  const api = { apiBaseUrl, authScope, client };
  const keysQuery = useOwnApiKeysQuery({ ...api, enabled: true });
  const contextQuery = usePlatformContextQuery({ ...api, enabled: true });
  const mutations = useOwnApiKeyMutations({
    ...api,
    heldMessage: t("apiAccessWaitsForApproval")
  });
  const context = contextQuery.data;
  const offer: KeyOffer = {
    actions: personalKeyActionOffer(context),
    namespaces: (context?.namespaces ?? []).map((namespace) => namespace.prefix)
  };
  const [initialCode] = useState(() => connectCodeOfSearch(window.location.search));
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  // The key of this person, shown once; another session's person never sees it.
  const [revealed, setRevealed] = useState<RevealedSecret & { ownerUserId: string }>();

  return (
    <>
      <PageHeader
        title={t("settings.apiKeys")}
        description={t("personalApiKeys.description")}
        primaryAction={
          <Button onClick={() => setNewKeyOpen(true)}>
            <KeyRound aria-hidden="true" />
            {t("personalApiKeys.new")}
          </Button>
        }
      />
      <Section
        layout="stacked"
        title={t("personalApiKeys.connectTitle")}
        description={t("personalApiKeys.connectDescription")}
      >
        <ConnectCli
          initialCode={initialCode}
          offer={offer}
          onConfirm={(userCode, body) =>
            mutations.confirmConnectCode.mutateAsync({ userCode, body })
          }
          confirming={mutations.confirmConnectCode.isPending}
        />
      </Section>
      <Section layout="stacked" title={t("personalApiKeys.yourKeys")}>
        {keysQuery.error ? (
          <Banner tone="danger">
            {apiErrorMessage(keysQuery.error, t("settings.requestFailed"))}
          </Banner>
        ) : (
          <PersonalApiKeysTable
            keys={keysQuery.data ?? []}
            loading={keysQuery.isPending}
            revoking={mutations.revoke.isPending}
            onRevoke={(key) => mutations.revoke.mutateAsync(key.id)}
          />
        )}
      </Section>
      {newKeyOpen ? (
        <NewKeyDialog
          offer={offer}
          pending={mutations.creating}
          onClose={() => setNewKeyOpen(false)}
          onSubmit={async (body) => {
            const response = await mutations.create(body);
            setNewKeyOpen(false);
            setRevealed({
              ownerUserId: user.id,
              secret: response.secret,
              credentialName: response.key.name,
              serverUrl: instanceUrl(apiBaseUrl, window.location.origin)
            });
          }}
        />
      ) : null}
      {revealed && revealed.ownerUserId === user.id ? (
        <PersonalKeyRevealDialog secret={revealed} onClose={() => setRevealed(undefined)} />
      ) : null}
    </>
  );
}

function NewKeyDialog({
  offer,
  pending,
  onClose,
  onSubmit
}: {
  offer: KeyOffer;
  pending: boolean;
  onClose(): void;
  /** A refusal is thrown and said in the dialog. */
  onSubmit(body: CreatePersonalApiKeyRequest): Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => initialPersonalKeyDraft());
  const [error, setError] = useState<string>();
  const request = personalKeyRequest(draft);
  const formId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = personalKeyRequest(draft);
    if (!body) return;
    setError(undefined);
    onSubmit(body).catch((caught: unknown) =>
      setError(apiErrorMessage(caught, t("settings.requestFailed")))
    );
  }

  return (
    <Dialog
      open
      title={t("personalApiKeys.new")}
      description={t("personalApiKeys.newDescription")}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" form={formId} loading={pending} disabled={!request}>
            {t("personalApiKeys.create")}
          </Button>
        </>
      }
    >
      <form id={formId} className="grid gap-4" onSubmit={submit}>
        <PersonalKeyFields
          draft={draft}
          actions={offer.actions}
          namespaces={offer.namespaces}
          onChange={(next) => {
            setDraft(next);
            setError(undefined);
          }}
        />
        {error ? <InlineError>{error}</InlineError> : null}
      </form>
    </Dialog>
  );
}

/** The connect code field, what the code asks for once it is whole, and its confirmation. */
function ConnectCli({
  initialCode,
  offer,
  confirming,
  onConfirm
}: {
  initialCode: string;
  offer: KeyOffer;
  confirming: boolean;
  onConfirm(userCode: string, body: ConfirmConnectCodeRequest): Promise<unknown>;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const [code, setCode] = useState(initialCode);
  const [confirmedCode, setConfirmedCode] = useState<string>();
  const complete = isCompleteConnectCode(code);
  const lookup = useConnectCodeQuery({
    apiBaseUrl,
    authScope,
    client,
    userCode: complete ? code : ""
  });

  return (
    <div className="grid gap-5">
      <Field label={t("personalApiKeys.code")} hint={t("personalApiKeys.codeHint")}>
        <Input
          value={code}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("personalApiKeys.codePlaceholder")}
          onChange={(event) => setCode(formatConnectCode(event.target.value))}
        />
      </Field>
      {confirmedCode && confirmedCode === code ? (
        <Banner tone="success" title={t("personalApiKeys.connected")}>
          {t("personalApiKeys.connectedDescription")}
        </Banner>
      ) : !complete ? null : lookup.isPending ? (
        <SkeletonList rows={2} />
      ) : lookup.data ? (
        <ConnectCodeConfirm
          key={code}
          code={code}
          request={lookup.data}
          offer={offer}
          pending={confirming}
          onConfirm={async (body) => {
            await onConfirm(code, body);
            setConfirmedCode(code);
          }}
        />
      ) : (
        <InlineError>{connectCodeError(lookup.error, t)}</InlineError>
      )}
    </div>
  );
}

function connectCodeError(error: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  if (error instanceof ApiError && error.status === 404) return t("personalApiKeys.codeUnknown");
  return apiErrorMessage(error, t("settings.requestFailed")) ?? t("settings.requestFailed");
}

/**
 * What a connect code asks for, the warning that only one's own terminal's code is confirmed,
 * and the fields of the key the CLI will collect.
 */
export function ConnectCodeConfirm({
  code,
  request,
  offer,
  pending,
  onConfirm
}: {
  code: string;
  request: ConnectCode;
  offer: KeyOffer;
  pending: boolean;
  /** A refusal is thrown and said under the fields. */
  onConfirm(body: ConfirmConnectCodeRequest): Promise<void>;
}) {
  const { t, locale } = useTranslation();
  const [draft, setDraft] = useState<PersonalKeyDraft>(() =>
    initialPersonalKeyDraft(request.clientLabel ?? t("personalApiKeys.cliName"))
  );
  const [error, setError] = useState<string>();
  const body = personalKeyRequest(draft);

  function submit(event: FormEvent) {
    event.preventDefault();
    const confirmed = personalKeyRequest(draft);
    if (!confirmed) return;
    setError(undefined);
    onConfirm(confirmed).catch((caught: unknown) => setError(connectCodeError(caught, t)));
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <KeyValueList>
        <KeyValue label={t("personalApiKeys.codeAsking")}>
          {request.clientLabel ?? t("personalApiKeys.unnamedClient")}
        </KeyValue>
        <KeyValue label={t("personalApiKeys.codeStarted")}>
          {formatDateTime(request.createdAt, locale)}
        </KeyValue>
        <KeyValue label={t("personalApiKeys.codeExpires")}>
          {formatDateTime(request.expiresAt, locale)}
        </KeyValue>
      </KeyValueList>
      <Banner tone="warning" title={t("personalApiKeys.ownTerminalOnly")}>
        {t("personalApiKeys.ownTerminalOnlyDescription", { code })}
      </Banner>
      <PersonalKeyFields
        draft={draft}
        actions={offer.actions}
        namespaces={offer.namespaces}
        onChange={(next) => {
          setDraft(next);
          setError(undefined);
        }}
      />
      {error ? <InlineError>{error}</InlineError> : null}
      <div>
        <Button type="submit" loading={pending} disabled={!body}>
          {t("personalApiKeys.confirm")}
        </Button>
      </div>
    </form>
  );
}
