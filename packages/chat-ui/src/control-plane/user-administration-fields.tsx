import { useState, type FocusEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  ACCESS_LEVEL_OPTIONS,
  generatePassword,
  type CreateUserFormState,
  type UserFormState
} from "./user-administration-model";
import { Field } from "./user-administration-primitives";
import { useTranslation } from "../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

export function UserFields({
  form,
  canManageSuperadminAccess,
  disabled = false,
  onChange
}: {
  form: UserFormState;
  canManageSuperadminAccess: boolean;
  disabled?: boolean;
  onChange(nextForm: UserFormState): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t("settings.displayLabel")}>
          <Input
            value={form.displayLabel}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, displayLabel: event.target.value })}
          />
        </Field>
        <Field label={t("email")}>
          <Input
            type="email"
            value={form.email}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, email: event.target.value })}
          />
        </Field>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t("settings.status")}>
          <Select
            value={form.status}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...form, status: event.target.value as UserFormState["status"] })
            }
          >
            <option value="active">{t("settings.statusActive")}</option>
            <option value="disabled">{t("settings.statusDisabled")}</option>
          </Select>
        </Field>
        <AccessLevelField
          value={form.accessLevel}
          canManageSuperadminAccess={canManageSuperadminAccess}
          disabled={disabled}
          onChange={(accessLevel) => onChange({ ...form, accessLevel })}
        />
        <Field label={t("settings.userPermissionRefs")} hint={t("settings.userPermissionRefsHint")}>
          <Input
            value={form.permissionRefs}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, permissionRefs: event.target.value })}
          />
        </Field>
      </div>
    </>
  );
}

export function CreateUserFields({
  form,
  canManageSuperadminAccess,
  invitationsEnabled,
  onChange
}: {
  form: CreateUserFormState;
  canManageSuperadminAccess: boolean;
  invitationsEnabled: boolean;
  onChange(nextForm: CreateUserFormState): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t("settings.displayLabel")}>
          <Input
            value={form.displayLabel}
            onChange={(event) => onChange({ ...form, displayLabel: event.target.value })}
          />
        </Field>
        <Field
          label={t("email")}
          hint={
            form.sendInvitation
              ? t("settings.userEmailInvitationHint")
              : form.createPasswordSignIn
                ? t("settings.userEmailPasswordHint")
                : undefined
          }
        >
          <Input
            type="email"
            value={form.email}
            onChange={(event) => onChange({ ...form, email: event.target.value })}
          />
        </Field>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <AccessLevelField
          value={form.accessLevel}
          canManageSuperadminAccess={canManageSuperadminAccess}
          onChange={(accessLevel) => onChange({ ...form, accessLevel })}
        />
        <Field label={t("settings.status")}>
          <Select
            value={form.status}
            onChange={(event) =>
              onChange({ ...form, status: event.target.value as CreateUserFormState["status"] })
            }
          >
            <option value="active">{t("settings.statusActive")}</option>
            <option value="disabled">{t("settings.statusDisabled")}</option>
          </Select>
        </Field>
      </div>
      {invitationsEnabled ? (
        <label className="inline-flex w-fit items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.sendInvitation}
            onChange={(event) => onChange({ ...form, sendInvitation: event.target.checked })}
          />
          <span>{t("settings.userInvite")}</span>
        </label>
      ) : null}
      {form.sendInvitation ? null : (
        <label className="inline-flex w-fit items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.createPasswordSignIn}
            onChange={(event) => onChange({ ...form, createPasswordSignIn: event.target.checked })}
          />
          <span>{t("settings.userPasswordSignInCreate")}</span>
        </label>
      )}
      {form.createPasswordSignIn && !form.sendInvitation ? (
        <Field label={t("settings.passwordInitial")} hint={t("settings.userInitialPasswordHint")}>
          <div className="flex gap-2">
            <MaskedPasswordInput
              value={form.password}
              autoComplete="new-password"
              onChange={(password) => onChange({ ...form, password })}
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              onClick={() => onChange({ ...form, password: generatePassword() })}
            >
              {t("settings.generate")}
            </Button>
          </div>
        </Field>
      ) : null}
      <details className="rounded-md border bg-muted/20 p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t("settings.userAdvancedPermissions")}
        </summary>
        <div className="mt-3">
          <Field
            label={t("settings.userPermissionRefs")}
            hint={t("settings.userPermissionRefsHint")}
          >
            <Input
              value={form.permissionRefs}
              onChange={(event) => onChange({ ...form, permissionRefs: event.target.value })}
            />
          </Field>
        </div>
      </details>
    </>
  );
}

export function MaskedPasswordInput({
  value,
  onChange,
  autoComplete,
  readOnly = false,
  disabled = false,
  onFocus
}: {
  value: string;
  onChange?(value: string): void;
  autoComplete?: string;
  readOnly?: boolean;
  disabled?: boolean;
  onFocus?(event: FocusEvent<HTMLInputElement>): void;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative min-w-0 flex-1">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        autoComplete={autoComplete}
        readOnly={readOnly}
        disabled={disabled}
        spellCheck={false}
        className="font-mono pr-10"
        onFocus={onFocus}
        onChange={(event) => onChange?.(event.target.value)}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute right-1 top-1/2 size-8 -translate-y-1/2 text-muted-foreground"
        aria-label={t(visible ? "settings.passwordHide" : "settings.passwordShow")}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((currentVisible) => !currentVisible)}
      >
        {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </Button>
    </div>
  );
}

function AccessLevelField({
  value,
  canManageSuperadminAccess,
  disabled = false,
  onChange
}: {
  value: CreateUserFormState["accessLevel"];
  canManageSuperadminAccess: boolean;
  disabled?: boolean;
  onChange(value: CreateUserFormState["accessLevel"]): void;
}) {
  const { t } = useTranslation();
  const selected = ACCESS_LEVEL_OPTIONS.find((option) => option.value === value);
  const options = ACCESS_LEVEL_OPTIONS.filter(
    (option) => canManageSuperadminAccess || option.value !== "superadmin" || value === "superadmin"
  );
  return (
    <Field label={t("settings.accessLevel")} hint={selected ? t(selected.description) : undefined}>
      <Select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as typeof value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </Select>
    </Field>
  );
}
