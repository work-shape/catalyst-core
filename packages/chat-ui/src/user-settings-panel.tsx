import { type FormEvent, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  ApiError,
  type ApiUser,
  type ChangeCurrentUserPasswordRequest,
  type LocaleCode,
  type UpdateCurrentUserRequest
} from "@vivd-catalyst/api-client";
import { useTranslation } from "./i18n";
import { LocaleSelector } from "./locale-selector";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

export function UserSettingsPanel({
  user,
  canChangePassword,
  updatingProfile,
  changingPassword,
  deletingAccount,
  locales,
  locale,
  onUpdateProfile,
  onChangePassword,
  onDeleteAccount,
  onSelectLocale
}: {
  user: ApiUser | undefined;
  canChangePassword: boolean;
  updatingProfile: boolean;
  changingPassword: boolean;
  deletingAccount: boolean;
  locales: LocaleCode[];
  locale: LocaleCode;
  onUpdateProfile(input: UpdateCurrentUserRequest): Promise<ApiUser>;
  onChangePassword(input: ChangeCurrentUserPasswordRequest): Promise<unknown>;
  onDeleteAccount(): Promise<unknown>;
  onSelectLocale(locale: LocaleCode): void;
}) {
  const { t, localeName } = useTranslation();
  const [displayLabel, setDisplayLabel] = useState(user?.displayLabel ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profileMessage, setProfileMessage] = useState<string | undefined>();
  const [profileError, setProfileError] = useState<string | undefined>();
  const [passwordMessage, setPasswordMessage] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState<string | undefined>();
  const normalizedDisplayLabel = displayLabel.trim();
  const profileChanged = normalizedDisplayLabel.length > 0 && normalizedDisplayLabel !== user?.displayLabel;

  useEffect(() => {
    setDisplayLabel(user?.displayLabel ?? "");
    setProfileMessage(undefined);
    setProfileError(undefined);
  }, [user?.displayLabel]);

  async function onProfileSubmit(event: FormEvent) {
    event.preventDefault();
    setProfileMessage(undefined);
    setProfileError(undefined);
    if (!normalizedDisplayLabel) {
      setProfileError(t("displayNameRequired"));
      return;
    }

    try {
      await onUpdateProfile({ displayLabel: normalizedDisplayLabel });
      setProfileMessage(t("profileUpdated"));
    } catch (error) {
      setProfileError(getErrorMessage(error, t("profileUpdateFailed")));
    }
  }

  async function onPasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setPasswordMessage(undefined);
    setPasswordError(undefined);
    if (!canChangePassword) {
      setPasswordError(t("passwordChangeUnavailable"));
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError(t("newPasswordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t("newPasswordsDoNotMatch"));
      return;
    }

    try {
      await onChangePassword({
        currentPassword,
        newPassword
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage(t("passwordUpdated"));
    } catch (error) {
      setPasswordError(getErrorMessage(error, t("passwordUpdateFailed")));
    }
  }

  async function onDeleteAccountConfirmed() {
    setDeleteAccountError(undefined);
    try {
      await onDeleteAccount();
      setDeleteAccountOpen(false);
    } catch (error) {
      setDeleteAccountError(getErrorMessage(error, t("accountDeleteFailed")));
    }
  }

  return (
    <>
      <section
        className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-background"
        aria-label={t("userSettings")}
      >
        <div className="grid min-h-0 content-start gap-4 overflow-auto bg-background px-5 pb-5 pt-20">
          <div className="grid w-full max-w-2xl gap-4">
            <div className="grid gap-1">
              <span className="text-xs text-muted-foreground">{t("settings")}</span>
              <h1 className="text-xl font-semibold tracking-normal">{t("account")}</h1>
            </div>
            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-base">{t("language")}</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3 p-4 pt-2">
                <span className="text-sm text-muted-foreground">{localeName(locale)}</span>
                <LocaleSelector locales={locales} selectedLocale={locale} onSelectLocale={onSelectLocale} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-base">{t("profile")}</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-2">
                <form className="grid gap-4" onSubmit={onProfileSubmit}>
                  <label className="grid gap-1.5 text-sm font-medium">
                    <span>{t("displayName")}</span>
                    <Input
                      autoComplete="name"
                      value={displayLabel}
                      onChange={(event) => {
                        setDisplayLabel(event.target.value);
                        setProfileMessage(undefined);
                        setProfileError(undefined);
                      }}
                    />
                  </label>
                  {user?.email ? (
                    <label className="grid gap-1.5 text-sm font-medium">
                      <span>{t("email")}</span>
                      <Input value={user.email} disabled />
                    </label>
                  ) : null}
                  <FormMessage message={profileMessage} error={profileError} />
                  <div className="flex justify-end">
                    <Button type="submit" disabled={updatingProfile || !profileChanged}>
                      {updatingProfile ? t("saving") : t("saveProfile")}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-base">{t("password")}</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-2">
                {canChangePassword ? (
                  <form className="grid gap-4" onSubmit={onPasswordSubmit}>
                    <label className="grid gap-1.5 text-sm font-medium">
                      <span>{t("currentPassword")}</span>
                      <Input
                        autoComplete="current-password"
                        type="password"
                        value={currentPassword}
                        onChange={(event) => {
                          setCurrentPassword(event.target.value);
                          setPasswordMessage(undefined);
                          setPasswordError(undefined);
                        }}
                      />
                    </label>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="grid gap-1.5 text-sm font-medium">
                        <span>{t("newPassword")}</span>
                        <Input
                          autoComplete="new-password"
                          type="password"
                          value={newPassword}
                          onChange={(event) => {
                            setNewPassword(event.target.value);
                            setPasswordMessage(undefined);
                            setPasswordError(undefined);
                          }}
                        />
                      </label>
                      <label className="grid gap-1.5 text-sm font-medium">
                        <span>{t("confirmPassword")}</span>
                        <Input
                          autoComplete="new-password"
                          type="password"
                          value={confirmPassword}
                          onChange={(event) => {
                            setConfirmPassword(event.target.value);
                            setPasswordMessage(undefined);
                            setPasswordError(undefined);
                          }}
                        />
                      </label>
                    </div>
                    <FormMessage message={passwordMessage} error={passwordError} />
                    <div className="flex justify-end">
                      <Button
                        type="submit"
                        disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
                      >
                        {changingPassword ? t("updating") : t("updatePassword")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    {t("passwordManagedExternally")}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="p-4 pb-2">
                <CardTitle className="text-base">{t("deleteAccount")}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 p-4 pt-2">
                <p className="text-sm leading-6 text-muted-foreground">
                  {t("deleteAccountDescription")}
                </p>
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-fit text-destructive hover:text-destructive"
                    disabled={deletingAccount}
                    onClick={() => {
                      setDeleteAccountError(undefined);
                      setDeleteAccountOpen(true);
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                    {t("deleteAccount")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      <Dialog
        open={deleteAccountOpen}
        title={t("deleteAccountDialogTitle")}
        onClose={() => {
          if (!deletingAccount) {
            setDeleteAccountOpen(false);
          }
        }}
      >
        <div className="grid gap-4">
          <p className="text-sm leading-6 text-muted-foreground">
            {t("deleteAccountDialogDescription")}
          </p>
          <FormMessage error={deleteAccountError} />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteAccountOpen(false)}
              disabled={deletingAccount}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => void onDeleteAccountConfirmed()}
              disabled={deletingAccount}
            >
              <Trash2 size={16} aria-hidden="true" />
              {deletingAccount ? t("deleting") : t("confirmDeleteAccount")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function FormMessage({
  message,
  error
}: {
  message?: string;
  error?: string;
}) {
  if (error) {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (message) {
    return (
      <p className="rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        {message}
      </p>
    );
  }
  return null;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
