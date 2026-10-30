import { CONNECTION_ASSET_KIND, assetAddressFromName } from "@work-shape/catalyst-core";
import type { ReactNode } from "react";
import {
  Banner,
  Button,
  Field,
  FormNotice,
  Input,
  NameWithAddress,
  Select,
  Step,
  Steps,
  Textarea,
  type AddressCheck
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { ConnectStep, ConnectStepState } from "./connection-connect";
import { connectionDraftForm, type ConnectionDraft } from "./connection-draft";
import {
  ConnectionHeaderRows,
  ConnectionOAuthDetailFields,
  ConnectionOAuthFields,
  ConnectionPersonContextHeaderField,
  ConnectionTestPathField,
  CredentialModeField
} from "./connection-form";
import {
  offersCredentialMode,
  type ConnectionCredentialMode,
  type ConnectionFormState,
  type ConnectionOAuthChoice
} from "./connection-form-model";
import { RefusalDetail } from "./refusal-notice";

// The second step of the New connection dialog: the name, what the Connection is for, the
// address and the key, with the
// id, how the key is sent and, for a REST API, its fixed headers and test path under
// "Technical details". The id follows the name until it is typed and is checked as it
// changes. The auth scheme follows the key field: empty sends none. A REST API may sign in
// with OAuth instead (CONN-OAUTH-1): its authorization server's addresses, the client and the
// permissions, with the client secret in the key's place.

/** How a REST API proves itself, as the dialog offers it: a key, or an OAuth choice. */
type CreateAuth = "key" | ConnectionOAuthChoice;

/** What the dialog asks for beside the definition's settings. */
export interface CreateFields {
  title: string;
  /** What the Connection is for, as agents and people read it. Empty for none. */
  description: string;
  /** The id as typed. Until it is, the id follows the name. */
  typedId?: string;
  form: ConnectionFormState;
  /** The key, in this browser only until the dialog closes. */
  key: string;
  sendAs: "bearer" | "header";
  /** For a REST API: a key, or an OAuth choice whose client secret is `key`. */
  auth: CreateAuth;
  /**
   * Whose account a Connection that signs a person in uses. Read only where the form offers the
   * choice (`offersCredentialMode`).
   */
  credentialMode: ConnectionCredentialMode;
}

/** Whether the fields make a personal Connection: chosen, where the form offers the choice. */
export function createsPersonal(fields: CreateFields): boolean {
  return (
    fields.credentialMode === "user" &&
    offersCredentialMode(
      fields.form.connectorType,
      fields.form.connectorType === "http_api" ? fields.auth : "key"
    )
  );
}

/** Where a field says what is wrong with it. */
export type CreateFieldErrors = Partial<
  Record<"id" | "url" | "key" | "headerName" | "headers" | "testPath" | "oauth" | "general", string>
> & {
  /** The instance's sentences behind the refusals, which only an administrator is shown. */
  detail?: string;
  /** `general` says no reason: only `detail` does. */
  untold?: boolean;
};

export function ConnectionCreateForm({
  fields,
  check,
  errors,
  busy,
  steps,
  detailsOpen = false,
  saved,
  idNotice,
  onChange
}: {
  fields: CreateFields;
  /** What the instance said of the id, as it is typed. A refused write's reason goes first. */
  check: AddressCheck;
  errors: CreateFieldErrors;
  /** Verbinden runs: the fields wait. */
  busy: boolean;
  /** The steps of the connect that runs, in their order. */
  steps: readonly { step: ConnectStep; state: ConnectStepState }[];
  /** "Technical details" starts open, as for a form filled with an id or headers to look at. */
  detailsOpen?: boolean;
  /**
   * The Connection was saved by an earlier Verbinden that then failed: it is in the list
   * already. Whether Cancel offers to discard it.
   */
  saved?: { discardable: boolean; onOpen?(): void };
  /** What the dialog says of a Connection that holds the id already, with its actions. */
  idNotice?: ReactNode;
  onChange(next: CreateFields): void;
}) {
  const { t } = useTranslation();
  const rest = fields.form.connectorType === "http_api";
  const auth: CreateAuth = rest ? fields.auth : "key";
  const oauth = auth !== "key";
  const offersMode = offersCredentialMode(fields.form.connectorType, auth);
  // A personal MCP server signs each person in: it takes no key.
  const takesKey = rest || !createsPersonal(fields);
  const form = (next: Partial<ConnectionFormState>) =>
    onChange({ ...fields, form: { ...fields.form, ...next } });
  const detailsShown =
    detailsOpen ||
    errors.headerName !== undefined ||
    errors.headers !== undefined ||
    errors.testPath !== undefined;
  return (
    <form
      id="connection-create-form"
      className="grid min-w-0 gap-4"
      data-connection-create-form={fields.form.connectorType}
      onSubmit={(event) => event.preventDefault()}
    >
      <NameWithAddress
        autoFocus
        value={{ name: fields.title, typedAddress: fields.typedId }}
        onChange={(named) =>
          onChange({ ...fields, title: named.name, typedId: named.typedAddress })
        }
        derive={(named) => assetAddressFromName(named, CONNECTION_ASSET_KIND)}
        check={errors.id === undefined ? check : { state: "refused", reason: errors.id }}
        nameLabel={t("connectionCreate.name")}
        addressLabel={t("connectionCreate.id")}
        addressHint={t("connectionCreate.idHint")}
        advancedLabel={t("connectionCreate.details")}
        advancedOpen={detailsShown}
        disabled={busy}
        advanced={
          <>
            {oauth ? (
              <ConnectionOAuthDetailFields
                oauth={fields.form.oauth}
                signsIn={auth === "oauth"}
                disabled={busy}
                onChange={(next) => form({ oauth: next })}
              />
            ) : (
              <Field label={t("connectionCreate.sendAs")}>
                <Select
                  value={fields.sendAs}
                  disabled={busy}
                  data-connection-field="sendAs"
                  onChange={(event) =>
                    onChange({
                      ...fields,
                      sendAs: event.target.value === "header" ? "header" : "bearer"
                    })
                  }
                >
                  <option value="bearer">{t("connectionCreate.sendAsBearer")}</option>
                  <option value="header">{t("connectionCreate.sendAsHeader")}</option>
                </Select>
              </Field>
            )}
            {!oauth && fields.sendAs === "header" ? (
              <Field label={t("connectionCreate.headerName")} error={errors.headerName} required>
                <Input
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={fields.form.headerName}
                  disabled={busy}
                  data-connection-field="headerName"
                  onChange={(event) => form({ headerName: event.target.value })}
                />
              </Field>
            ) : null}
            {rest ? (
              <>
                <ConnectionHeaderRows
                  rows={fields.form.headers}
                  disabled={busy}
                  onChange={(headers) => form({ headers })}
                />
                {errors.headers ? <FormNotice tone="error">{errors.headers}</FormNotice> : null}
                <ConnectionTestPathField
                  value={fields.form.testPath}
                  disabled={busy}
                  onChange={(testPath) => form({ testPath })}
                />
                {errors.testPath ? <FormNotice tone="error">{errors.testPath}</FormNotice> : null}
                <ConnectionPersonContextHeaderField
                  value={fields.form.personContextHeader}
                  disabled={busy}
                  onChange={(personContextHeader) => form({ personContextHeader })}
                />
              </>
            ) : null}
          </>
        }
      >
        <Field
          label={t("connectionPage.descriptionField")}
          hint={t("connectionPage.descriptionHint")}
          optional
        >
          <Textarea
            rows={2}
            value={fields.description}
            disabled={busy}
            data-connection-field="description"
            onChange={(event) => onChange({ ...fields, description: event.target.value })}
          />
        </Field>
        <Field
          label={t(rest ? "connectionCreate.baseUrl" : "connectionCreate.serverUrl")}
          hint={rest ? t("connectionCreate.baseUrlHint") : undefined}
          error={errors.url}
          required
        >
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={fields.form.url}
            disabled={busy}
            data-connection-field="url"
            onChange={(event) => form({ url: event.target.value })}
          />
        </Field>
        {rest ? (
          <Field
            label={t("connectionCreate.auth")}
            hint={
              auth === "oauth"
                ? t("connectionCreate.authOAuthHint")
                : auth === "oauth_client"
                  ? t("connectionCreate.authOAuthClientHint")
                  : undefined
            }
          >
            <Select
              value={auth}
              disabled={busy}
              data-connection-field="auth"
              onChange={(event) => {
                const value = event.target.value;
                onChange({
                  ...fields,
                  auth: value === "oauth" || value === "oauth_client" ? value : "key"
                });
              }}
            >
              <option value="key">{t("connectionCreate.authKey")}</option>
              <option value="oauth">{t("connectionCreate.authOAuth")}</option>
              <option value="oauth_client">{t("connectionCreate.authOAuthClient")}</option>
            </Select>
          </Field>
        ) : null}
        {offersMode ? (
          <CredentialModeField
            value={fields.credentialMode}
            disabled={busy}
            onChange={(credentialMode) => onChange({ ...fields, credentialMode })}
          />
        ) : null}
        {oauth ? (
          <ConnectionOAuthFields
            oauth={fields.form.oauth}
            signsIn={auth === "oauth"}
            disabled={busy}
            errors={errors.oauth === undefined ? {} : { oauth: errors.oauth }}
            onChange={(next) => form({ oauth: next })}
          />
        ) : null}
        {takesKey ? (
          <Field
            label={t(oauth ? "connectionCreate.oauthClientSecret" : "connectionCreate.key")}
            {...(auth === "oauth_client" ? { required: true } : { optional: true })}
            hint={t(
              auth === "oauth_client"
                ? "connectionCreate.oauthClientSecretRequired"
                : oauth
                  ? "connectionCreate.oauthClientSecretHint"
                  : rest
                    ? "connectionCreate.keyHint"
                    : "connectionCreate.keyHintMcp"
            )}
            error={errors.key}
          >
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={fields.key}
              disabled={busy}
              data-connection-field="secret"
              onChange={(event) => onChange({ ...fields, key: event.target.value })}
            />
          </Field>
        ) : null}
      </NameWithAddress>
      {idNotice}
      {steps.length > 0 ? (
        <Steps label={t("connectionCreate.steps")} data-connection-steps="">
          {steps.map(({ step, state }) => (
            <Step
              key={step}
              state={state}
              data-connect-step={step}
              title={t(
                step === "server"
                  ? "connectionCreate.stepServer"
                  : step === "key"
                    ? oauth
                      ? "connectionCreate.stepClient"
                      : "connectionCreate.stepKey"
                    : "connectionCreate.stepTools"
              )}
            />
          ))}
        </Steps>
      ) : null}
      {saved ? (
        <Banner
          layout="line"
          data-connection-create-saved=""
          action={
            saved.onOpen ? (
              <Button
                variant="link"
                size="sm"
                disabled={busy}
                data-connection-create-saved-open=""
                onClick={saved.onOpen}
              >
                {t("connectionCreate.savedOpen")}
              </Button>
            ) : undefined
          }
        >
          {t(saved.discardable ? "connectionCreate.savedDiscardable" : "connectionCreate.saved", {
            name: fields.title.trim()
          })}
        </Banner>
      ) : null}
      {errors.general ? (
        <FormNotice tone="error" data-connection-create-error="">
          {errors.general}
        </FormNotice>
      ) : null}
      <RefusalDetail detail={errors.detail} untold={errors.untold ?? false} />
    </form>
  );
}

/** The fields of a new MCP server or REST API filled with the agent's draft or proposal. */
export function draftedFields(draft: ConnectionDraft): CreateFields {
  const { name, title, keyHeader, authScheme, credentialMode } = draft.connection;
  return {
    title,
    description: "",
    ...(name === assetAddressFromName(title, CONNECTION_ASSET_KIND) ? {} : { typedId: name }),
    form: connectionDraftForm(draft),
    key: "",
    sendAs: keyHeader === undefined ? "bearer" : "header",
    auth: authScheme === "oauth" || authScheme === "oauth_client" ? authScheme : "key",
    // A proposal of a personal Connection opens on "each person signs in".
    credentialMode: credentialMode === "user" ? "user" : "shared"
  };
}
