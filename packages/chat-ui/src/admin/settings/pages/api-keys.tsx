import { KeyRound } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import {
  ApiError,
  type ConfirmConnectCodeRequest,
  type ConnectCode,
  type CreatePersonalApiKeyRequest
} from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  Dialog,
  Field,
  Input,
  KeyValue,
  KeyValueList,
  PageHeader,
  Section,
  SkeletonList
} from "@work-shape/catalyst-ui";
import {
  useConnectCodeQuery,
  useOwnApiKeyMutations,
  useOwnApiKeysQuery
} from "../../../shared/api/personal-api-keys";
import { usePlatformContextQuery } from "../../../shared/api/workspace-queries";
import type { RevealedSecret } from "../../control-plane/api-access-secret-fields";
import { formatMomentShort } from "../../../shared/locale-format";
import { PersonalKeyFields } from "../../control-plane/personal-api-key-fields";
import {
  KeyProblemNotice,
  PersonalApiKeysTable,
  PersonalKeyRevealDialog,
  type KeyProblem
} from "../../control-plane/personal-api-keys-list";
import {
  connectCodeAsksUseLevel,
  connectCodeOfSearch,
  formatConnectCode,
  initialPersonalKeyDraft,
  instanceUrl,
  isCompleteConnectCode,
  personalKeyActionOffer,
  personalKeyRequest,
  personalKeyUseOffer,
  setupKeyActions,
  type PersonalKeyDraft
} from "../../control-plane/personal-api-keys-model";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import { apiErrorMessage } from "../../../shared/workspace-utils";
import { useOptionalSettingsPage, useSettingsPage } from "../../../shared/settings-page-context";
import { isRefusal, refusalAskingInstanceAdmin } from "../ask-instance-admin";

/** What the key fields offer: the actions, the use level and the Namespaces. */
interface KeyOffer {
  actions: string[];
  useActions: string[];
  /** What the key `catalyst setup` asks for starts with ticked (`setupKeyActions`). */
  setupActions: string[];
  namespaces: string[];
  /** The instance has answered what it offers, or failed to. */
  settled: boolean;
}

/**
 * You > API keys: the person's own keys first, issuing one, and below them confirming the connect
 * code the CLI shows. The CLI sends the person here as `?code=ABCD-EFGH`.
 */
export function ApiKeysPage() {
  const { apiBaseUrl, authScope, client, user } = useSettingsPage();
  const { t } = useTranslation();
  const keyProblem = useKeyProblem();
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
    useActions: personalKeyUseOffer(context),
    setupActions: setupKeyActions(context),
    namespaces: (context?.namespaces ?? []).map((namespace) => namespace.prefix),
    settled: !contextQuery.isPending
  };
  const [initialCode] = useState(() => connectCodeOfSearch(window.location.search));
  const [asksUseLevel] = useState(() => connectCodeAsksUseLevel(window.location.search));
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
      <Section layout="stacked" title={t("personalApiKeys.yourKeys")}>
        {keysQuery.error ? (
          <KeyListProblem problem={keyProblem(keysQuery.error, "personalApiKeys.listRefused")} />
        ) : (
          <PersonalApiKeysTable
            keys={keysQuery.data ?? []}
            loading={keysQuery.isPending}
            revoking={mutations.revoke.isPending}
            onRevoke={(key) => mutations.revoke.mutateAsync(key.id)}
            revokeProblem={(caught) => keyProblem(caught, "personalApiKeys.revokeRefused")}
          />
        )}
      </Section>
      <Section
        layout="stacked"
        title={t("personalApiKeys.connectTitle")}
        description={t("personalApiKeys.connectDescription")}
      >
        <ConnectCli
          initialCode={initialCode}
          asksUseLevel={asksUseLevel}
          offer={offer}
          onConfirm={(userCode, body) =>
            mutations.confirmConnectCode.mutateAsync({ userCode, body })
          }
          confirming={mutations.confirmConnectCode.isPending}
        />
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
  const keyProblem = useKeyProblem();
  const [draft, setDraft] = useState(() => initialPersonalKeyDraft());
  const [problem, setProblem] = useState<KeyProblem>();
  // The same key would be refused again: Create key waits for a changed field.
  const request = problem?.refused ? undefined : personalKeyRequest(draft);
  const formId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!request) return;
    setProblem(undefined);
    onSubmit(request).catch((caught: unknown) =>
      setProblem(keyProblem(caught, "personalApiKeys.issueRefused"))
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
          {/* In the pinned footer, a full line above the buttons: the fields scroll, so a problem
              under them would stand below the fold where Create key was pressed. */}
          {problem ? <KeyProblemNotice problem={problem} /> : null}
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
          useActions={offer.useActions}
          namespaces={offer.namespaces}
          onChange={(next) => {
            setDraft(next);
            setProblem(undefined);
          }}
        />
      </form>
    </Dialog>
  );
}

/** The connect code field, what the code asks for once it is whole, and its confirmation. */
function ConnectCli({
  initialCode,
  asksUseLevel,
  offer,
  confirming,
  onConfirm
}: {
  initialCode: string;
  /** The CLI's `setup` sent the person here: its key starts with the use level. */
  asksUseLevel: boolean;
  offer: KeyOffer;
  confirming: boolean;
  onConfirm(userCode: string, body: ConfirmConnectCodeRequest): Promise<unknown>;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const keyProblem = useKeyProblem();
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
      ) : !complete ? null : lookup.isPending || !offer.settled ? (
        <SkeletonList rows={2} />
      ) : lookup.data ? (
        <ConnectCodeConfirm
          key={code}
          code={code}
          request={lookup.data}
          offer={offer}
          // Only the code the CLI sent the person with asks for the level; a typed one does not.
          asksUseLevel={asksUseLevel && code === initialCode}
          pending={confirming}
          onConfirm={async (body) => {
            await onConfirm(code, body);
            setConfirmedCode(code);
          }}
        />
      ) : (
        <KeyProblemNotice problem={connectCodeProblem(lookup.error, t, keyProblem)} />
      )}
    </div>
  );
}

type KeyProblemOf = (error: unknown, refusal: TranslationKey) => KeyProblem;

/** What a refused or failed answer says on this page. A refusal names whom to ask. */
function useKeyProblem(): KeyProblemOf {
  const { t } = useTranslation();
  const instanceAdminName = useOptionalSettingsPage()?.user.instanceAdminName;
  return (error, refusal) =>
    isRefusal(error)
      ? { message: refusalAskingInstanceAdmin(t(refusal), t, instanceAdminName), refused: true }
      : {
          message:
            apiErrorMessage(error, t("settings.requestFailed")) ?? t("settings.requestFailed"),
          refused: false
        };
}

/** A list that could not be read: a refusal as information, a failure as a danger. */
function KeyListProblem({ problem }: { problem: KeyProblem }) {
  return <Banner tone={problem.refused ? "info" : "danger"}>{problem.message}</Banner>;
}

function connectCodeProblem(
  error: unknown,
  t: ReturnType<typeof useTranslation>["t"],
  keyProblem: KeyProblemOf
): KeyProblem {
  if (error instanceof ApiError && error.status === 404) {
    return { message: t("personalApiKeys.codeUnknown"), refused: false };
  }
  return keyProblem(error, "personalApiKeys.issueRefused");
}

/**
 * What a connect code asks for, the warning that only one's own terminal's code is confirmed,
 * and the fields of the key the CLI will collect.
 */
export function ConnectCodeConfirm({
  code,
  request,
  offer,
  asksUseLevel = false,
  pending,
  onConfirm
}: {
  code: string;
  request: ConnectCode;
  offer: KeyOffer;
  /**
   * Start as `catalyst setup` asks: the person's reading, writing and publishing rights and
   * the use level ticked.
   */
  asksUseLevel?: boolean;
  pending: boolean;
  /** A refusal is thrown and said under the fields. */
  onConfirm(body: ConfirmConnectCodeRequest): Promise<void>;
}) {
  const { t, locale } = useTranslation();
  const keyProblem = useKeyProblem();
  const [draft, setDraft] = useState<PersonalKeyDraft>(() =>
    initialPersonalKeyDraft(
      request.clientLabel ?? t("personalApiKeys.cliName"),
      asksUseLevel ? offer.setupActions : []
    )
  );
  const [problem, setProblem] = useState<KeyProblem>();
  // The same key would be refused again: Confirm waits for a changed field.
  const body = problem?.refused ? undefined : personalKeyRequest(draft);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!body) return;
    setProblem(undefined);
    onConfirm(body).catch((caught: unknown) =>
      setProblem(connectCodeProblem(caught, t, keyProblem))
    );
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <KeyValueList>
        <KeyValue label={t("personalApiKeys.codeAsking")}>
          {request.clientLabel ?? t("personalApiKeys.unnamedClient")}
        </KeyValue>
        <KeyValue label={t("personalApiKeys.codeStarted")}>
          {formatMomentShort(request.createdAt, locale)}
        </KeyValue>
        <KeyValue label={t("personalApiKeys.codeExpires")}>
          {formatMomentShort(request.expiresAt, locale)}
        </KeyValue>
      </KeyValueList>
      <Banner tone="warning" title={t("personalApiKeys.ownTerminalOnly")}>
        {t("personalApiKeys.ownTerminalOnlyDescription", { code })}
      </Banner>
      <PersonalKeyFields
        draft={draft}
        actions={offer.actions}
        useActions={offer.useActions}
        namespaces={offer.namespaces}
        onChange={(next) => {
          setDraft(next);
          setProblem(undefined);
        }}
      />
      {problem ? <KeyProblemNotice problem={problem} /> : null}
      <div>
        <Button type="submit" loading={pending} disabled={!body}>
          {t("personalApiKeys.confirm")}
        </Button>
      </div>
    </form>
  );
}
