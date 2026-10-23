import { X } from "lucide-react";
import { useId } from "react";
import { Button, Field, IconButton, Input, RadioGroup, Select } from "@work-shape/catalyst-ui";
import {
  useTranslation,
  type TranslationContextValue,
  type TranslationKey
} from "../../shared/i18n";
import {
  CONNECTION_AUTH_CHOICES,
  CONNECTION_OAUTH_CHOICES,
  isOAuthChoice,
  sendsSecret,
  type ConnectionCredentialMode,
  type ConnectionFormAuthScheme,
  type ConnectionFormState,
  type ConnectionHeaderRow,
  type ConnectionOAuthForm
} from "./connection-form-model";

const AUTH_LABELS: Record<
  ConnectionFormAuthScheme,
  { label: TranslationKey; text: TranslationKey }
> = {
  oauth: { label: "connections.authOAuth", text: "connections.authOAuthText" },
  oauth_client: { label: "connections.authOAuthClient", text: "connections.authOAuthClientText" },
  none: { label: "connections.authNone", text: "connections.authNoneText" },
  bearer: { label: "connections.authBearer", text: "connections.authBearerText" },
  header: { label: "connections.authHeader", text: "connections.authHeaderText" }
};

const CONNECTOR_TYPE_LABELS = new Map<string, TranslationKey>([
  ["mcp", "connectionCreate.mcpTitle"],
  ["http_api", "connectionCreate.restTitle"]
]);

const AUTH_SCHEME_LABELS = new Map<string, TranslationKey>(
  Object.entries(AUTH_LABELS).map(([scheme, { label }]) => [scheme, label])
);

/** A Connector type in words. A type the interface does not know keeps its id. */
export function connectorTypeLabel(type: string, t: TranslationContextValue["t"]): string {
  const key = CONNECTOR_TYPE_LABELS.get(type);
  return key === undefined ? type : t(key);
}

/** How a Connection proves itself, in words. A scheme the interface does not know keeps its id. */
export function authSchemeLabel(scheme: string, t: TranslationContextValue["t"]): string {
  const key = AUTH_SCHEME_LABELS.get(scheme);
  return key === undefined ? scheme : t(key);
}

/** The address of the server and, for a REST API, its fixed headers and its test path. */
export function ConnectionServerFields({
  form,
  onChange
}: {
  form: ConnectionFormState;
  onChange(next: ConnectionFormState): void;
}) {
  const { t } = useTranslation();
  const rest = form.connectorType === "http_api";
  return (
    <>
      <Field
        label={t(rest ? "connectionCreate.baseUrl" : "connections.url")}
        hint={t(rest ? "connectionCreate.baseUrlHint" : "connections.urlHint")}
        required
      >
        <Input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={form.url}
          data-connection-field="url"
          onChange={(event) => onChange({ ...form, url: event.target.value })}
        />
      </Field>
      {rest ? (
        <>
          <ConnectionHeaderRows
            rows={form.headers}
            onChange={(headers) => onChange({ ...form, headers })}
          />
          <ConnectionTestPathField
            value={form.testPath}
            onChange={(testPath) => onChange({ ...form, testPath })}
          />
          <ConnectionPersonContextHeaderField
            value={form.personContextHeader}
            onChange={(personContextHeader) => onChange({ ...form, personContextHeader })}
          />
        </>
      ) : null}
    </>
  );
}

/** What a list of name and value rows is called: fixed headers, or extra parameters. */
const ROW_TEXTS = {
  headers: {
    label: "connectionCreate.headers",
    hint: "connectionCreate.headersHint",
    name: "connectionCreate.headerRowName",
    value: "connectionCreate.headerRowValue",
    add: "connectionCreate.headerAdd",
    remove: "connectionCreate.headerRemove"
  },
  params: {
    label: "connectionCreate.oauthParams",
    hint: "connectionCreate.oauthParamsHint",
    name: "connectionCreate.oauthParamName",
    value: "connectionCreate.oauthParamValue",
    add: "connectionCreate.oauthParamAdd",
    remove: "connectionCreate.oauthParamRemove"
  }
} as const satisfies Record<string, Record<string, TranslationKey>>;

/**
 * The fixed headers of a REST API, or the extra parameters of its authorization address: a
 * name and a value per row, never a credential.
 */
export function ConnectionHeaderRows({
  rows,
  onChange,
  disabled = false,
  kind = "headers"
}: {
  rows: readonly ConnectionHeaderRow[];
  onChange(rows: ConnectionHeaderRow[]): void;
  disabled?: boolean;
  kind?: keyof typeof ROW_TEXTS;
}) {
  const { t } = useTranslation();
  const texts = ROW_TEXTS[kind];
  // The field's label names the first header's name; every other input has an id of its own.
  const base = useId();
  const change = (index: number, row: ConnectionHeaderRow) =>
    onChange(rows.map((current, at) => (at === index ? row : current)));
  return (
    <div
      className="grid min-w-0 gap-2"
      data-connection-field={kind === "headers" ? "headers" : "oauthParams"}
    >
      <Field label={t(texts.label)} hint={t(texts.hint)} optional>
        <div className="grid min-w-0 gap-2">
          {rows.map((row, index) => (
            <div key={index} className="flex min-w-0 items-center gap-2">
              <Input
                id={index === 0 ? undefined : `${base}-name-${index}`}
                className="min-w-0 flex-1 font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-label={t(texts.name)}
                placeholder={t(texts.name)}
                value={row.name}
                disabled={disabled}
                onChange={(event) => change(index, { ...row, name: event.target.value })}
              />
              <Input
                id={`${base}-value-${index}`}
                className="min-w-0 flex-1 font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-label={t(texts.value)}
                placeholder={t(texts.value)}
                value={row.value}
                disabled={disabled}
                onChange={(event) => change(index, { ...row, value: event.target.value })}
              />
              <IconButton
                label={t(texts.remove, { name: row.name })}
                disabled={disabled}
                onClick={() => onChange(rows.filter((_, at) => at !== index))}
              >
                <X aria-hidden="true" />
              </IconButton>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            disabled={disabled}
            onClick={() => onChange([...rows, { name: "", value: "" }])}
          >
            {t(texts.add)}
          </Button>
        </div>
      </Field>
    </div>
  );
}

/** The path the test of a REST API asks. */
export function ConnectionTestPathField({
  value,
  onChange,
  disabled = false
}: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Field
      label={t("connectionCreate.testPath")}
      hint={t("connectionCreate.testPathHint")}
      optional
    >
      <Input
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        data-connection-field="testPath"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** The header a REST API sends the value mapped to the person or service principal in. */
export function ConnectionPersonContextHeaderField({
  value,
  onChange,
  disabled = false
}: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Field
      label={t("connectionCreate.personContextHeader")}
      hint={t("connectionCreate.personContextHeaderHint")}
      optional
    >
      <Input
        className="font-mono"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        data-connection-field="personContextHeader"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/**
 * How the instance proves itself, and the header the key goes into. With `secret` the key is
 * asked for too: a field of the browser that is never filled from a stored value.
 */
export function ConnectionAuthFields({
  form,
  onChange,
  secret,
  offersOAuth = false
}: {
  form: ConnectionFormState;
  onChange(next: ConnectionFormState): void;
  secret?: { value: string; onChange(value: string): void };
  /** The Connection signs in with OAuth: that stays one of the choices. */
  offersOAuth?: boolean;
}) {
  const { t } = useTranslation();
  const rest = form.connectorType === "http_api";
  // A REST API names its authorization server itself, so it may always choose OAuth; an MCP
  // server keeps OAuth only where its server asked for a sign-in.
  const choices: readonly ConnectionFormAuthScheme[] = rest
    ? [...CONNECTION_AUTH_CHOICES, ...CONNECTION_OAUTH_CHOICES]
    : [...(offersOAuth ? (["oauth"] as const) : []), ...CONNECTION_AUTH_CHOICES];
  return (
    <>
      <RadioGroup<ConnectionFormAuthScheme>
        label={t("connections.authTitle")}
        value={form.authScheme}
        onValueChange={(authScheme) => onChange({ ...form, authScheme })}
        options={choices.map((choice) => ({
          value: choice,
          label: t(AUTH_LABELS[choice].label),
          description: t(AUTH_LABELS[choice].text)
        }))}
      />
      {rest && isOAuthChoice(form.authScheme) ? (
        <>
          <ConnectionOAuthFields
            oauth={form.oauth}
            signsIn={form.authScheme === "oauth"}
            onChange={(oauth) => onChange({ ...form, oauth })}
          />
          <ConnectionOAuthDetailFields
            oauth={form.oauth}
            signsIn={form.authScheme === "oauth"}
            onChange={(oauth) => onChange({ ...form, oauth })}
          />
        </>
      ) : null}
      {form.authScheme === "header" ? (
        <Field label={t("connections.headerName")} hint={t("connections.headerNameHint")} required>
          <Input
            autoComplete="off"
            spellCheck={false}
            value={form.headerName}
            data-connection-field="headerName"
            onChange={(event) => onChange({ ...form, headerName: event.target.value })}
          />
        </Field>
      ) : null}
      {secret && sendsSecret(form.authScheme) ? (
        <ConnectionSecretField value={secret.value} onChange={secret.onChange} />
      ) : null}
    </>
  );
}

/**
 * Whose account the Connection uses: Shared, one account for everyone, or Personal, each
 * person's own. Chosen when the Connection is made; afterwards it shows locked, with why.
 */
export function CredentialModeField({
  value,
  onChange,
  disabled
}: {
  value: ConnectionCredentialMode;
  /** Absent once the Connection is made: the choice is fixed. */
  onChange?(value: ConnectionCredentialMode): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div data-connection-field="credentialMode" data-credential-mode={value}>
      <RadioGroup<ConnectionCredentialMode>
        label={t("personalConnections.whoseAccount")}
        value={value}
        disabled={disabled || onChange === undefined}
        {...(onChange ? { onValueChange: onChange } : {})}
        {...(onChange ? {} : { hint: t("personalConnections.modeLocked") })}
        options={[
          {
            value: "shared",
            label: t("personalConnections.modeShared"),
            description: t("personalConnections.modeSharedText")
          },
          {
            value: "user",
            label: t("personalConnections.modePersonal"),
            description: t("personalConnections.modePersonalText")
          }
        ]}
      />
    </div>
  );
}

/** The key, typed once. The browser is asked not to keep or offer it. */
export function ConnectionSecretField({
  value,
  onChange
}: {
  value: string;
  onChange(value: string): void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("connections.secret")} hint={t("connections.secretHint")}>
      <Input
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        data-connection-field="secret"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** The address fields of a REST API's authorization server, and its client and permissions. */
export function ConnectionOAuthFields({
  oauth,
  signsIn,
  onChange,
  disabled = false,
  errors = {}
}: {
  oauth: ConnectionOAuthForm;
  /** A person signs in (`oauth`): the authorization address is asked for too. */
  signsIn: boolean;
  onChange(next: ConnectionOAuthForm): void;
  disabled?: boolean;
  errors?: { oauth?: string };
}) {
  const { t } = useTranslation();
  const set = (next: Partial<ConnectionOAuthForm>) => onChange({ ...oauth, ...next });
  return (
    <>
      {signsIn ? (
        <Field
          label={t("connectionCreate.oauthAuthorizationUrl")}
          hint={t("connectionCreate.oauthAuthorizationUrlHint")}
          required
        >
          <Input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={oauth.authorizationUrl}
            disabled={disabled}
            data-connection-field="oauthAuthorizationUrl"
            onChange={(event) => set({ authorizationUrl: event.target.value })}
          />
        </Field>
      ) : null}
      <Field
        label={t("connectionCreate.oauthTokenUrl")}
        hint={t("connectionCreate.oauthTokenUrlHint")}
        error={errors.oauth}
        required
      >
        <Input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={oauth.tokenUrl}
          disabled={disabled}
          data-connection-field="oauthTokenUrl"
          onChange={(event) => set({ tokenUrl: event.target.value })}
        />
      </Field>
      <Field label={t("connectionCreate.oauthClientId")} required>
        <Input
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={oauth.clientId}
          disabled={disabled}
          data-connection-field="oauthClientId"
          onChange={(event) => set({ clientId: event.target.value })}
        />
      </Field>
      <Field
        label={t("connectionCreate.oauthScopes")}
        hint={t("connectionCreate.oauthScopesHint")}
        optional
      >
        <Input
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={oauth.scopes}
          disabled={disabled}
          data-connection-field="oauthScopes"
          onChange={(event) => set({ scopes: event.target.value })}
        />
      </Field>
    </>
  );
}

/**
 * What of a REST API's authorization server only some providers need: the revocation address,
 * how the client proves itself at the token address and, for a sign-in, extra parameters.
 */
export function ConnectionOAuthDetailFields({
  oauth,
  signsIn,
  onChange,
  disabled = false
}: {
  oauth: ConnectionOAuthForm;
  signsIn: boolean;
  onChange(next: ConnectionOAuthForm): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const set = (next: Partial<ConnectionOAuthForm>) => onChange({ ...oauth, ...next });
  return (
    <>
      <Field label={t("connectionCreate.oauthAuthMethod")}>
        <Select
          value={oauth.tokenAuthMethod}
          disabled={disabled}
          data-connection-field="oauthAuthMethod"
          onChange={(event) =>
            set({
              tokenAuthMethod:
                event.target.value === "client_secret_basic"
                  ? "client_secret_basic"
                  : "client_secret_post"
            })
          }
        >
          <option value="client_secret_post">{t("connectionCreate.oauthAuthMethodPost")}</option>
          <option value="client_secret_basic">{t("connectionCreate.oauthAuthMethodBasic")}</option>
        </Select>
      </Field>
      {signsIn ? (
        <>
          <Field
            label={t("connectionCreate.oauthRevocationUrl")}
            hint={t("connectionCreate.oauthRevocationUrlHint")}
            optional
          >
            <Input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={oauth.revocationUrl}
              disabled={disabled}
              data-connection-field="oauthRevocationUrl"
              onChange={(event) => set({ revocationUrl: event.target.value })}
            />
          </Field>
          <ConnectionHeaderRows
            kind="params"
            rows={oauth.params}
            disabled={disabled}
            onChange={(params) => set({ params })}
          />
        </>
      ) : null}
    </>
  );
}
