import { Field, Input, RadioGroup } from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  CONNECTION_AUTH_CHOICES,
  sendsSecret,
  type ConnectionAuthChoice,
  type ConnectionFormState
} from "./connection-form-model";

const AUTH_LABELS: Record<ConnectionAuthChoice, { label: TranslationKey; text: TranslationKey }> = {
  none: { label: "connections.authNone", text: "connections.authNoneText" },
  bearer: { label: "connections.authBearer", text: "connections.authBearerText" },
  header: { label: "connections.authHeader", text: "connections.authHeaderText" }
};

/** The address of the server. */
export function ConnectionServerFields({
  form,
  onChange
}: {
  form: ConnectionFormState;
  onChange(next: ConnectionFormState): void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("connections.url")} hint={t("connections.urlHint")} required>
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
  );
}

/**
 * How the instance proves itself, and the header the key goes into. With `secret` the key is
 * asked for too: a field of the browser that is never filled from a stored value.
 */
export function ConnectionAuthFields({
  form,
  onChange,
  secret
}: {
  form: ConnectionFormState;
  onChange(next: ConnectionFormState): void;
  secret?: { value: string; onChange(value: string): void };
}) {
  const { t } = useTranslation();
  return (
    <>
      <RadioGroup<ConnectionAuthChoice>
        label={t("connections.authTitle")}
        value={form.authScheme}
        onValueChange={(authScheme) => onChange({ ...form, authScheme })}
        options={CONNECTION_AUTH_CHOICES.map((choice) => ({
          value: choice,
          label: t(AUTH_LABELS[choice].label),
          description: t(AUTH_LABELS[choice].text)
        }))}
      />
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
