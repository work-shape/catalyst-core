import { X } from "lucide-react";
import { useId } from "react";
import { Button, Field, IconButton, Input, RadioGroup } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import {
  CONNECTION_AUTH_CHOICES,
  sendsSecret,
  type ConnectionAuthChoice,
  type ConnectionFormState,
  type ConnectionHeaderRow
} from "./connection-form-model";

const AUTH_LABELS: Record<ConnectionAuthChoice, { label: TranslationKey; text: TranslationKey }> = {
  none: { label: "connections.authNone", text: "connections.authNoneText" },
  bearer: { label: "connections.authBearer", text: "connections.authBearerText" },
  header: { label: "connections.authHeader", text: "connections.authHeaderText" }
};

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
        </>
      ) : null}
    </>
  );
}

/** The fixed headers of a REST API: a name and a value per row, never a credential. */
export function ConnectionHeaderRows({
  rows,
  onChange,
  disabled = false
}: {
  rows: readonly ConnectionHeaderRow[];
  onChange(rows: ConnectionHeaderRow[]): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  // The field's label names the first header's name; every other input has an id of its own.
  const base = useId();
  const change = (index: number, row: ConnectionHeaderRow) =>
    onChange(rows.map((current, at) => (at === index ? row : current)));
  return (
    <div className="grid min-w-0 gap-2" data-connection-field="headers">
      <Field
        label={t("connectionCreate.headers")}
        hint={t("connectionCreate.headersHint")}
        optional
      >
        <div className="grid min-w-0 gap-2">
          {rows.map((row, index) => (
            <div key={index} className="flex min-w-0 items-center gap-2">
              <Input
                id={index === 0 ? undefined : `${base}-name-${index}`}
                className="min-w-0 flex-1 font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("connectionCreate.headerRowName")}
                placeholder={t("connectionCreate.headerRowName")}
                value={row.name}
                disabled={disabled}
                onChange={(event) => change(index, { ...row, name: event.target.value })}
              />
              <Input
                id={`${base}-value-${index}`}
                className="min-w-0 flex-1 font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-label={t("connectionCreate.headerRowValue")}
                placeholder={t("connectionCreate.headerRowValue")}
                value={row.value}
                disabled={disabled}
                onChange={(event) => change(index, { ...row, value: event.target.value })}
              />
              <IconButton
                label={t("connectionCreate.headerRemove", { name: row.name })}
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
            {t("connectionCreate.headerAdd")}
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
