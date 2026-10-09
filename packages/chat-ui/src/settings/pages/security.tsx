import { type FormEvent, useState } from "react";
import { ApiError } from "@vivd-catalyst/api-client";
import { Button, Field, FormNotice, Input, PageHeader, Section } from "@vivd-catalyst/ui";
import { useChangeCurrentUserPasswordMutation } from "../../api/workspace-mutations";
import { useTranslation } from "../../i18n";
import { useSettingsPage } from "../settings-page-context";

/** The shortest password this form sends on. The server holds the rule; this spares a round trip. */
const MIN_PASSWORD_LENGTH_CHARS = 8;

type Notice = { tone: "error" | "success"; text: string };

/** You > Security: the password of an account this instance keeps the password of. */
export function SecurityPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const changePassword = useChangeCurrentUserPasswordMutation({ apiBaseUrl, authScope, client });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState<Notice | undefined>();
  const complete = Boolean(currentPassword && newPassword && confirmPassword);

  function save(event: FormEvent) {
    event.preventDefault();
    setNotice(undefined);
    if (newPassword.length < MIN_PASSWORD_LENGTH_CHARS) {
      setNotice({ tone: "error", text: t("newPasswordTooShort") });
      return;
    }
    if (newPassword !== confirmPassword) {
      setNotice({ tone: "error", text: t("newPasswordsDoNotMatch") });
      return;
    }
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
          setNotice({ tone: "success", text: t("passwordUpdated") });
        },
        onError: (error) =>
          setNotice({
            tone: "error",
            text: error instanceof ApiError ? error.message : t("passwordUpdateFailed")
          })
      }
    );
  }

  const field = (value: string, change: (next: string) => void, autoComplete: string) => (
    <Input
      type="password"
      autoComplete={autoComplete}
      value={value}
      onChange={(event) => {
        change(event.currentTarget.value);
        setNotice(undefined);
      }}
    />
  );

  return (
    <>
      <PageHeader title={t("settings.security")} />
      <Section layout="stacked" title={t("password")}>
        <form className="grid gap-5" onSubmit={save}>
          <Field label={t("currentPassword")}>
            {field(currentPassword, setCurrentPassword, "current-password")}
          </Field>
          <Field label={t("newPassword")}>
            {field(newPassword, setNewPassword, "new-password")}
          </Field>
          <Field label={t("confirmPassword")}>
            {field(confirmPassword, setConfirmPassword, "new-password")}
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={changePassword.isPending} disabled={!complete}>
              {t("updatePassword")}
            </Button>
            {notice ? <FormNotice tone={notice.tone}>{notice.text}</FormNotice> : null}
          </div>
        </form>
      </Section>
    </>
  );
}
