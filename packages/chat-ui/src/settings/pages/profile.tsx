import { type FormEvent, useEffect, useState } from "react";
import { ApiError } from "@vivd-catalyst/api-client";
import {
  Button,
  ConfirmDialog,
  Field,
  FormNotice,
  Input,
  PageHeader,
  Section
} from "@vivd-catalyst/ui";
import {
  useDeleteCurrentUserMutation,
  useUpdateCurrentUserMutation
} from "../../api/workspace-mutations";
import { useTranslation } from "../../i18n";
import { useSettingsPage } from "../settings-page-context";

type Notice = { tone: "error" | "success"; text: string };

/** You > Profile: the person's name and email, and the way to delete the account. */
export function ProfilePage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client, user, onAccountDeleted } = useSettingsPage();
  const updateProfile = useUpdateCurrentUserMutation({ apiBaseUrl, authScope, client });
  const deleteAccount = useDeleteCurrentUserMutation({
    apiBaseUrl,
    authScope,
    client,
    onDeleted: onAccountDeleted
  });
  const [displayLabel, setDisplayLabel] = useState(user.displayLabel);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [nameError, setNameError] = useState<string | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const name = displayLabel.trim();
  const changed = name.length > 0 && name !== user.displayLabel;

  useEffect(() => {
    setDisplayLabel(user.displayLabel);
  }, [user.displayLabel]);

  function save(event: FormEvent) {
    event.preventDefault();
    setNotice(undefined);
    if (!name) {
      setNameError(t("displayNameRequired"));
      return;
    }
    updateProfile.mutate(
      { displayLabel: name },
      {
        onSuccess: () => setNotice({ tone: "success", text: t("profileUpdated") }),
        onError: (error) =>
          setNotice({ tone: "error", text: errorText(error, t("profileUpdateFailed")) })
      }
    );
  }

  function confirmDelete() {
    setDeleteError(undefined);
    deleteAccount.mutate(undefined, {
      onSuccess: () => setDeleteOpen(false),
      onError: (error) => setDeleteError(errorText(error, t("accountDeleteFailed")))
    });
  }

  return (
    <>
      <PageHeader title={t("settings.profile")} />
      <Section layout="stacked" title={t("settings.yourDetails")}>
        <form className="grid gap-5" onSubmit={save}>
          <Field label={t("displayName")} error={nameError} required>
            <Input
              autoComplete="name"
              value={displayLabel}
              onChange={(event) => {
                setDisplayLabel(event.currentTarget.value);
                setNameError(undefined);
                setNotice(undefined);
              }}
            />
          </Field>
          {user.email ? (
            <Field label={t("email")}>
              <Input value={user.email} disabled readOnly />
            </Field>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={updateProfile.isPending} disabled={!changed}>
              {t("saveProfile")}
            </Button>
            {notice ? <FormNotice tone={notice.tone}>{notice.text}</FormNotice> : null}
          </div>
        </form>
      </Section>
      <Section
        layout="stacked"
        title={t("deleteAccount")}
        description={t("deleteAccountDescription")}
      >
        <div>
          <Button
            variant="outline"
            disabled={deleteAccount.isPending}
            onClick={() => {
              setDeleteError(undefined);
              setDeleteOpen(true);
            }}
          >
            {t("deleteAccount")}
          </Button>
        </div>
      </Section>
      <ConfirmDialog
        open={deleteOpen}
        title={t("deleteAccountDialogTitle")}
        confirmLabel={t("confirmDeleteAccount")}
        loading={deleteAccount.isPending}
        onConfirm={confirmDelete}
        onClose={() => setDeleteOpen(false)}
      >
        {t("deleteAccountDialogDescription")}
        {deleteError ? (
          <FormNotice tone="error" className="mt-3">
            {deleteError}
          </FormNotice>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
