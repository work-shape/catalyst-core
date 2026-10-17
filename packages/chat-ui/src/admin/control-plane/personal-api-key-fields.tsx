import { useId, useState } from "react";
import { Checkbox, Field, Input, Select } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { actionLabel } from "../access/right-words";
import {
  PERSONAL_KEY_EXPIRY_DAYS,
  personalKeyDraftProblem,
  personalKeyExpiryOf,
  type PersonalKeyDraft
} from "./personal-api-keys-model";

/**
 * The name, the scopes and the end of a personal key: the same fields for a new key and for a
 * CLI's connect code. The scopes are actions, all limited to one Namespace where one is given,
 * each named as the rights screens name it.
 */
export function PersonalKeyFields({
  draft,
  actions,
  namespaces,
  onChange
}: {
  draft: PersonalKeyDraft;
  /** The actions offered, in order, by their ids. */
  actions: readonly string[];
  /** The Namespace prefixes the person holds a right in, offered while typing. */
  namespaces: readonly string[];
  onChange(draft: PersonalKeyDraft): void;
}) {
  const { t } = useTranslation();
  const namespaceListId = useId();
  // A wrong Namespace is said once the person left the field, not at every keystroke.
  const [namespaceTouched, setNamespaceTouched] = useState(false);
  const problem = personalKeyDraftProblem(draft);

  return (
    <div className="grid gap-5">
      <Field label={t("personalApiKeys.name")} required hint={t("personalApiKeys.nameHint")}>
        <Input
          value={draft.name}
          maxLength={100}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="text-label">{t("personalApiKeys.actions")}</legend>
        <p className="text-caption text-muted-foreground">{t("personalApiKeys.actionsHint")}</p>
        <div className="grid gap-2">
          {actions.map((action) => (
            <Checkbox
              key={action}
              label={actionLabel(action, t)}
              checked={draft.actions.includes(action)}
              onCheckedChange={(checked) =>
                onChange({
                  ...draft,
                  actions: checked
                    ? actions.filter((item) => item === action || draft.actions.includes(item))
                    : draft.actions.filter((item) => item !== action)
                })
              }
            />
          ))}
        </div>
      </fieldset>
      <Field
        label={t("personalApiKeys.namespace")}
        optional
        hint={t("personalApiKeys.namespaceHint")}
        error={
          namespaceTouched && problem === "namespace"
            ? t("personalApiKeys.namespaceInvalid")
            : undefined
        }
      >
        <Input
          value={draft.namespace}
          list={namespaceListId}
          placeholder={t("personalApiKeys.namespacePlaceholder")}
          onBlur={() => setNamespaceTouched(true)}
          onChange={(event) => onChange({ ...draft, namespace: event.target.value })}
        />
      </Field>
      <datalist id={namespaceListId}>
        {namespaces.map((prefix) => (
          <option key={prefix} value={prefix} />
        ))}
      </datalist>
      <Field label={t("personalApiKeys.expiry")}>
        <Select
          value={String(draft.expiryDays)}
          onChange={(event) => {
            const expiryDays = personalKeyExpiryOf(event.target.value);
            if (expiryDays) onChange({ ...draft, expiryDays });
          }}
        >
          {PERSONAL_KEY_EXPIRY_DAYS.map((days) => (
            <option key={days} value={String(days)}>
              {t("personalApiKeys.expiryDays", { days })}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
