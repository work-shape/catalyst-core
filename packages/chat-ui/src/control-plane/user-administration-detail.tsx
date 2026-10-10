import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, KeyRound, Link2, Mail, Plus, Save, Trash2 } from "lucide-react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  Input,
  KeyValue,
  KeyValueList
} from "@vivd-catalyst/ui";
import { MaskedPasswordInput, UserFields } from "./user-administration-fields";
import {
  STANDALONE_AUTH_SOURCE,
  emptyIdentityForm,
  errorMessage,
  formToIdentityInput,
  formToUpdateInput,
  generatePassword,
  userToForm,
  type FormNoticeState,
  type IdentityFormState,
  type UserFormState
} from "./user-administration-model";
import { Field, FormNotice, StatusBadge, UserAvatar } from "./user-administration-primitives";
import { UserPermissionsCard } from "./user-permissions-card";
import { formatDateTime } from "./locale-format";
import { useTranslation } from "../i18n";

export function UserDetail({
  user,
  canManageSuperadminAccess,
  canDeleteUser,
  mutating,
  onBack,
  onUpdateUser,
  onDeleteUser,
  onDeleted,
  onUpsertIdentity,
  onDeleteIdentity,
  onResetPassword,
  onSendInvitation
}: {
  user: AdministeredUser;
  canManageSuperadminAccess: boolean;
  canDeleteUser: boolean;
  mutating: boolean;
  onBack(): void;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
  onDeleteUser(userId: string): Promise<AdministeredUser | undefined>;
  onDeleted(): void;
  onUpsertIdentity(
    userId: string,
    input: UpsertAdministeredUserIdentityRequest
  ): Promise<AdministeredUser>;
  onDeleteIdentity(userId: string, identity: AdministeredUserIdentity): Promise<AdministeredUser>;
  onResetPassword(userId: string, password: string): Promise<unknown>;
  onSendInvitation?(userId: string): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const canManageUser = canManageSuperadminAccess || !user.roles.includes("superadmin");
  const managementDisabledReason = canManageUser ? undefined : t("settings.userSuperadminOnly");

  return (
    <div className="grid content-start gap-4">
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft size={15} aria-hidden="true" />
          {t("settings.userAllUsers")}
        </Button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <UserAvatar displayLabel={user.displayLabel} size="lg" />
        <div className="grid min-w-0 gap-0.5">
          <strong className="truncate text-lg font-semibold">{user.displayLabel}</strong>
          <span className="truncate text-sm text-muted-foreground">{user.email ?? user.id}</span>
        </div>
        <StatusBadge status={user.status} />
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
        <div className="grid content-start gap-4">
          <ProfileCard
            user={user}
            canManageSuperadminAccess={canManageSuperadminAccess}
            disabledReason={managementDisabledReason}
            mutating={mutating}
            onUpdateUser={onUpdateUser}
          />
          <UserPermissionsCard
            user={user}
            canManageSuperadminAccess={canManageSuperadminAccess}
            disabledReason={managementDisabledReason}
            mutating={mutating}
            onUpdateUser={onUpdateUser}
          />
          <IdentitiesCard
            user={user}
            disabledReason={managementDisabledReason}
            mutating={mutating}
            onUpsertIdentity={onUpsertIdentity}
            onDeleteIdentity={onDeleteIdentity}
          />
        </div>
        <div className="grid content-start gap-4">
          <PasswordCard
            user={user}
            disabledReason={managementDisabledReason}
            mutating={mutating}
            onResetPassword={onResetPassword}
            onSendInvitation={onSendInvitation}
          />
          <DeleteUserCard
            user={user}
            canDeleteUser={canDeleteUser}
            mutating={mutating}
            onDeleteUser={onDeleteUser}
            onDeleted={onDeleted}
          />
          <AccountMetaCard user={user} />
        </div>
      </div>
    </div>
  );
}

function ProfileCard({
  user,
  canManageSuperadminAccess,
  disabledReason,
  mutating,
  onUpdateUser
}: {
  user: AdministeredUser;
  canManageSuperadminAccess: boolean;
  disabledReason?: string;
  mutating: boolean;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<UserFormState>(() => userToForm(user));
  const [notice, setNotice] = useState<FormNoticeState>();

  useEffect(() => {
    setForm(userToForm(user));
    setNotice(undefined);
  }, [user.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    try {
      await onUpdateUser(user.id, formToUpdateInput(form));
      setNotice({ kind: "success", text: t("settings.userChangesSaved") });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, t("settings.requestFailed")) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">{t("profile")}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        <form className="grid gap-3" onSubmit={submit}>
          <UserFields
            form={form}
            canManageSuperadminAccess={canManageSuperadminAccess}
            disabled={Boolean(disabledReason)}
            onChange={setForm}
          />
          {disabledReason ? (
            <p className="text-sm text-muted-foreground">{disabledReason}</p>
          ) : null}
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={mutating || Boolean(disabledReason) || !form.displayLabel.trim()}
            >
              <Save size={16} aria-hidden="true" />
              {t("settings.userSaveChanges")}
            </Button>
            <FormNotice notice={notice} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function IdentitiesCard({
  user,
  disabledReason,
  mutating,
  onUpsertIdentity,
  onDeleteIdentity
}: {
  user: AdministeredUser;
  disabledReason?: string;
  mutating: boolean;
  onUpsertIdentity(
    userId: string,
    input: UpsertAdministeredUserIdentityRequest
  ): Promise<AdministeredUser>;
  onDeleteIdentity(userId: string, identity: AdministeredUserIdentity): Promise<AdministeredUser>;
}) {
  const { t } = useTranslation();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<IdentityFormState>(emptyIdentityForm);
  const [confirmingKey, setConfirmingKey] = useState<string | undefined>();
  const [notice, setNotice] = useState<FormNoticeState>();

  useEffect(() => {
    setFormOpen(false);
    setForm(emptyIdentityForm);
    setConfirmingKey(undefined);
    setNotice(undefined);
  }, [user.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    try {
      await onUpsertIdentity(user.id, formToIdentityInput(form));
      setForm(emptyIdentityForm);
      setFormOpen(false);
      setNotice({ kind: "success", text: t("settings.userIdentityLinked") });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, t("settings.requestFailed")) });
    }
  }

  async function deleteIdentity(identity: AdministeredUserIdentity) {
    setNotice(undefined);
    try {
      await onDeleteIdentity(user.id, identity);
      setConfirmingKey(undefined);
      setNotice({ kind: "success", text: t("settings.userIdentityRemoved") });
    } catch (error) {
      setConfirmingKey(undefined);
      setNotice({ kind: "error", text: errorMessage(error, t("settings.requestFailed")) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 size={17} aria-hidden="true" />
            {t("settings.userIdentities")}
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(disabledReason)}
            onClick={() => setFormOpen((open) => !open)}
          >
            <Plus size={15} aria-hidden="true" />
            {t("settings.userIdentityLink")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">{t("settings.userIdentitiesDescription")}</p>
        <div className="grid gap-2">
          {user.identities.map((identity) => {
            const key = `${identity.authSource}:${identity.externalUserId}`;
            return (
              <div
                key={key}
                className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3 text-sm"
              >
                <div className="grid min-w-0 flex-1 gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge appearance="outline">{identity.authSource}</Badge>
                    {identity.emailVerified ? (
                      <Badge tone="success">{t("settings.userIdentityVerified")}</Badge>
                    ) : null}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {identity.externalUserId}
                  </span>
                  {identity.email || identity.displayLabel ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {[identity.displayLabel, identity.email].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </div>
                {confirmingKey === key ? (
                  <span className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={mutating || Boolean(disabledReason)}
                      onClick={() => void deleteIdentity(identity)}
                    >
                      {t("settings.remove")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingKey(undefined)}
                    >
                      {t("cancel")}
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t("settings.userIdentityDelete", { source: identity.authSource })}
                    disabled={mutating || Boolean(disabledReason)}
                    onClick={() => setConfirmingKey(key)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
            );
          })}
          {user.identities.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.userIdentitiesEmpty")}</p>
          ) : null}
        </div>

        {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}

        {formOpen ? (
          <form className="grid gap-3 rounded-md border bg-muted/30 p-3" onSubmit={submit}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("settings.userIdentityAuthSource")}>
                <Input
                  value={form.authSource}
                  placeholder={emptyIdentityForm.authSource}
                  onChange={(event) => setForm({ ...form, authSource: event.target.value })}
                />
              </Field>
              <Field label={t("settings.userIdentityExternalId")}>
                <Input
                  value={form.externalUserId}
                  onChange={(event) => setForm({ ...form, externalUserId: event.target.value })}
                />
              </Field>
              <Field label={t("settings.displayLabel")}>
                <Input
                  value={form.displayLabel}
                  onChange={(event) => setForm({ ...form, displayLabel: event.target.value })}
                />
              </Field>
              <Field label={t("email")}>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
              </Field>
            </div>
            <label className="inline-flex w-fit items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.emailVerified}
                onChange={(event) => setForm({ ...form, emailVerified: event.target.checked })}
              />
              <span>{t("settings.userIdentityEmailVerified")}</span>
            </label>
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={mutating || !form.authSource.trim() || !form.externalUserId.trim()}
              >
                <Link2 size={15} aria-hidden="true" />
                {t("settings.userIdentitySave")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setFormOpen(false)}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        ) : null}

        <FormNotice notice={notice} />
      </CardContent>
    </Card>
  );
}

function PasswordCard({
  user,
  disabledReason,
  mutating,
  onResetPassword,
  onSendInvitation
}: {
  user: AdministeredUser;
  disabledReason?: string;
  mutating: boolean;
  onResetPassword(userId: string, password: string): Promise<unknown>;
  onSendInvitation?(userId: string): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<FormNoticeState>();
  const hasPasswordIdentity = user.identities.some(
    (identity) => identity.authSource === STANDALONE_AUTH_SOURCE
  );

  useEffect(() => {
    setPassword("");
    setNotice(undefined);
  }, [user.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    try {
      await onResetPassword(user.id, password);
      setNotice({
        kind: "success",
        text: t(
          hasPasswordIdentity
            ? "settings.userPasswordUpdated"
            : "settings.userPasswordSignInCreated"
        )
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, t("settings.requestFailed")) });
    }
  }

  async function sendInvitation() {
    if (!onSendInvitation) {
      return;
    }
    setNotice(undefined);
    try {
      await onSendInvitation(user.id);
      setNotice({ kind: "success", text: t("settings.userPasswordLinkSent") });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, t("settings.requestFailed")) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound size={17} aria-hidden="true" />
          {t("password")}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        <form className="grid gap-3" onSubmit={submit}>
          {!hasPasswordIdentity ? (
            <p className="text-sm text-muted-foreground">{t("settings.userPasswordMissing")}</p>
          ) : null}
          {disabledReason ? (
            <p className="text-sm text-muted-foreground">{disabledReason}</p>
          ) : null}
          <Field
            label={t(hasPasswordIdentity ? "newPassword" : "settings.passwordInitial")}
            hint={t(user.email ? "settings.userPasswordHint" : "settings.userPasswordNeedsEmail")}
          >
            <div className="flex gap-2">
              <MaskedPasswordInput
                value={password}
                autoComplete={hasPasswordIdentity ? "off" : "new-password"}
                disabled={Boolean(disabledReason)}
                onChange={setPassword}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={Boolean(disabledReason)}
                onClick={() => setPassword(generatePassword())}
              >
                {t("settings.generate")}
              </Button>
            </div>
          </Field>
          <Button
            type="submit"
            disabled={
              mutating ||
              Boolean(disabledReason) ||
              password.length < 8 ||
              (!hasPasswordIdentity && !user.email)
            }
          >
            <KeyRound size={16} aria-hidden="true" />
            {t(
              hasPasswordIdentity
                ? "settings.userPasswordReset"
                : "settings.userPasswordSignInCreate"
            )}
          </Button>
          {onSendInvitation ? (
            <Button
              type="button"
              variant="outline"
              disabled={
                mutating || Boolean(disabledReason) || !user.email || user.status !== "active"
              }
              onClick={() => void sendInvitation()}
            >
              <Mail size={16} aria-hidden="true" />
              {t("settings.userPasswordEmailLink")}
            </Button>
          ) : null}
          <FormNotice notice={notice} />
        </form>
      </CardContent>
    </Card>
  );
}

function DeleteUserCard({
  user,
  canDeleteUser,
  mutating,
  onDeleteUser,
  onDeleted
}: {
  user: AdministeredUser;
  canDeleteUser: boolean;
  mutating: boolean;
  onDeleteUser(userId: string): Promise<AdministeredUser | undefined>;
  onDeleted(): void;
}) {
  const { t } = useTranslation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState<FormNoticeState>();
  const confirmationTarget = user.email ?? user.id;
  // The sentence is one message; the value to type sits inside it as its own element.
  const [beforeTarget, afterTarget] = t("settings.userDeleteTypeToConfirm").split("{target}");

  useEffect(() => {
    setDeleteOpen(false);
    setConfirmation("");
    setNotice(undefined);
  }, [user.id]);

  if (!canDeleteUser) {
    return null;
  }

  async function deleteUser() {
    setNotice(undefined);
    try {
      await onDeleteUser(user.id);
      onDeleted();
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, t("settings.requestFailed")) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">{t("deleteAccount")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">
          {t(
            user.status === "deleting"
              ? "settings.userDeletionInProgress"
              : "settings.userDeleteDescription"
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          className="w-fit text-destructive hover:text-destructive"
          disabled={mutating}
          onClick={() => {
            setConfirmation("");
            setNotice(undefined);
            setDeleteOpen(true);
          }}
        >
          <Trash2 size={16} aria-hidden="true" />
          {t("settings.userDelete")}
        </Button>
        <Dialog
          open={deleteOpen}
          title={t("settings.userDeleteDialogTitle", { name: user.displayLabel })}
          onClose={() => {
            if (!mutating) {
              setDeleteOpen(false);
            }
          }}
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (confirmation === confirmationTarget && !mutating) {
                void deleteUser();
              }
            }}
          >
            <div className="grid gap-2 text-sm text-muted-foreground">
              <p>{t("settings.userDeleteDialogDescription")}</p>
              <p>
                {beforeTarget}
                <strong className="font-mono text-foreground">{confirmationTarget}</strong>
                {afterTarget}
              </p>
            </div>
            <Field label={t("settings.userDeleteConfirmation")}>
              <Input
                autoComplete="off"
                spellCheck={false}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </Field>
            <FormNotice notice={notice} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={mutating}
                onClick={() => setDeleteOpen(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={mutating || confirmation !== confirmationTarget}
              >
                <Trash2 size={16} aria-hidden="true" />
                {t(mutating ? "settings.userDeleting" : "settings.userDeletePermanently")}
              </Button>
            </div>
          </form>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function AccountMetaCard({ user }: { user: AdministeredUser }) {
  const { t, locale } = useTranslation();
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">{t("account")}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        <KeyValueList>
          <KeyValue label={t("settings.userId")}>
            <span className="font-mono text-xs break-all">{user.id}</span>
          </KeyValue>
          <KeyValue label={t("settings.created")}>
            {formatDateTime(user.createdAt, locale)}
          </KeyValue>
          <KeyValue label={t("settings.updated")}>
            {formatDateTime(user.updatedAt, locale)}
          </KeyValue>
          <KeyValue label={t("settings.userLastActive")}>
            {user.lastAuthenticatedAt
              ? formatDateTime(user.lastAuthenticatedAt, locale)
              : t("settings.never")}
          </KeyValue>
        </KeyValueList>
      </CardContent>
    </Card>
  );
}
