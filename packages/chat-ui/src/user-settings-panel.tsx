import { type FormEvent, useEffect, useState, type ReactNode } from "react";
import {
  ApiError,
  type ApiUser,
  type ChangeCurrentUserPasswordRequest,
  type UpdateCurrentUserRequest
} from "@agent-chat-platform/api-client";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

export function UserSettingsPanel({
  user,
  canChangePassword,
  updatingProfile,
  changingPassword,
  onUpdateProfile,
  onChangePassword,
  headerActions
}: {
  user: ApiUser | undefined;
  canChangePassword: boolean;
  updatingProfile: boolean;
  changingPassword: boolean;
  onUpdateProfile(input: UpdateCurrentUserRequest): Promise<ApiUser>;
  onChangePassword(input: ChangeCurrentUserPasswordRequest): Promise<unknown>;
  headerActions?: ReactNode;
}) {
  const [displayLabel, setDisplayLabel] = useState(user?.displayLabel ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [profileMessage, setProfileMessage] = useState<string | undefined>();
  const [profileError, setProfileError] = useState<string | undefined>();
  const [passwordMessage, setPasswordMessage] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
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
      setProfileError("Display name is required");
      return;
    }

    try {
      await onUpdateProfile({ displayLabel: normalizedDisplayLabel });
      setProfileMessage("Profile updated");
    } catch (error) {
      setProfileError(getErrorMessage(error, "Profile update failed"));
    }
  }

  async function onPasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setPasswordMessage(undefined);
    setPasswordError(undefined);
    if (!canChangePassword) {
      setPasswordError("Password changes are not available for this account");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
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
      setPasswordMessage("Password updated");
    } catch (error) {
      setPasswordError(getErrorMessage(error, "Password update failed"));
    }
  }

  return (
    <section
      className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background"
      aria-label="User settings"
    >
      <header className="flex min-h-16 min-w-0 items-center justify-between gap-4 border-b px-5 py-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate text-xs text-muted-foreground">Settings</span>
          <strong className="truncate text-sm font-semibold">Account</strong>
        </div>
        {headerActions ? <div className="flex shrink-0 items-center gap-2">{headerActions}</div> : null}
      </header>

      <div className="grid min-h-0 content-start gap-4 overflow-auto bg-background p-5">
        <div className="grid w-full max-w-2xl gap-4">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">Profile</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <form className="grid gap-4" onSubmit={onProfileSubmit}>
                <label className="grid gap-1.5 text-sm font-medium">
                  <span>Display name</span>
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
                    <span>Email</span>
                    <Input value={user.email} disabled />
                  </label>
                ) : null}
                <FormMessage message={profileMessage} error={profileError} />
                <div className="flex justify-end">
                  <Button type="submit" disabled={updatingProfile || !profileChanged}>
                    {updatingProfile ? "Saving" : "Save profile"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base">Password</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              {canChangePassword ? (
                <form className="grid gap-4" onSubmit={onPasswordSubmit}>
                  <label className="grid gap-1.5 text-sm font-medium">
                    <span>Current password</span>
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
                      <span>New password</span>
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
                      <span>Confirm password</span>
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
                      {changingPassword ? "Updating" : "Update password"}
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  Password is managed outside this chat.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
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
