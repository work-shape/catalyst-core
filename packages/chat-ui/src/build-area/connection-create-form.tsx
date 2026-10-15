import {
  Field,
  FormNotice,
  Input,
  NameWithAddress,
  Select,
  Step,
  Steps,
  type AddressCheck
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { assetIdFromTitle } from "./build-model";
import type { BuildNamespace } from "./build-rights";
import type { ConnectStep, ConnectStepState } from "./connection-connect";
import { ConnectionHeaderRows, ConnectionTestPathField } from "./connection-form";
import type { ConnectionFormState } from "./connection-form-model";

// The second step of the New connection dialog: the name, the address and the key, with the
// id, how the key is sent and, for a REST API, its fixed headers and test path under
// "Technical details". The id follows the name until it is typed and is checked as it
// changes. The auth scheme follows the key field: empty sends none.

/** The choice of no Namespace: the id is taken as typed. */
export const NO_NAMESPACE = "";

/** What the dialog asks for beside the definition's settings. */
export interface CreateFields {
  title: string;
  /** The id as typed. Until it is, the id follows the name. */
  typedId?: string;
  prefix: string;
  form: ConnectionFormState;
  /** The key, in this browser only until the dialog closes. */
  key: string;
  sendAs: "bearer" | "header";
}

/** Where a field says what is wrong with it. */
export type CreateFieldErrors = Partial<
  Record<"id" | "url" | "key" | "headerName" | "headers" | "testPath" | "general", string>
>;

export function ConnectionCreateForm({
  fields,
  check,
  namespaces,
  errors,
  busy,
  steps,
  onChange
}: {
  fields: CreateFields;
  /** What the instance said of the id, as it is typed. A refused write's reason goes first. */
  check: AddressCheck;
  /** The Namespaces offered; the choice of none among them where the reader may name freely. */
  namespaces: readonly BuildNamespace[];
  errors: CreateFieldErrors;
  /** Verbinden runs: the fields wait. */
  busy: boolean;
  /** The steps of the connect that runs, in their order. */
  steps: readonly { step: ConnectStep; state: ConnectStepState }[];
  onChange(next: CreateFields): void;
}) {
  const { t } = useTranslation();
  const rest = fields.form.connectorType === "http_api";
  const form = (next: Partial<ConnectionFormState>) =>
    onChange({ ...fields, form: { ...fields.form, ...next } });
  const detailsWrong =
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
        derive={assetIdFromTitle}
        check={errors.id === undefined ? check : { state: "refused", reason: errors.id }}
        nameLabel={t("connectionCreate.name")}
        addressLabel={t("connectionCreate.id")}
        addressHint={t("connectionCreate.idHint")}
        advancedLabel={t("connectionCreate.details")}
        advancedOpen={detailsWrong}
        disabled={busy}
        advanced={
          <>
            {namespaces.length > 1 ? (
              <Field label={t("connectionCreate.namespace")}>
                <Select
                  value={fields.prefix}
                  disabled={busy}
                  onChange={(event) => onChange({ ...fields, prefix: event.target.value })}
                >
                  {namespaces.map((namespace) => (
                    <option key={namespace.prefix} value={namespace.prefix}>
                      {namespace.prefix === NO_NAMESPACE
                        ? namespace.displayName
                        : `${namespace.displayName} (${namespace.prefix})`}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
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
            {fields.sendAs === "header" ? (
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
              </>
            ) : null}
          </>
        }
      >
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
        <Field
          label={t("connectionCreate.key")}
          optional
          hint={t(rest ? "connectionCreate.keyHint" : "connectionCreate.keyHintMcp")}
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
      </NameWithAddress>
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
                    ? "connectionCreate.stepKey"
                    : "connectionCreate.stepTools"
              )}
            />
          ))}
        </Steps>
      ) : null}
      {errors.general ? (
        <FormNotice tone="error" data-connection-create-error="">
          {errors.general}
        </FormNotice>
      ) : null}
    </form>
  );
}
