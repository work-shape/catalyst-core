import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, KeyRound, Link2, Plus, Save, Trash2 } from "lucide-react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";
import { MaskedPasswordInput, UserFields } from "./user-administration-fields";
import {
  STANDALONE_AUTH_SOURCE,
  emptyIdentityForm,
  errorMessage,
  formToIdentityInput,
  formToUpdateInput,
  formatDateTime,
  generatePassword,
  userToForm,
  type FormNoticeState,
  type IdentityFormState,
  type UserFormState
} from "./user-administration-model";
import { Field, FormNotice, StatusBadge, UserAvatar } from "./user-administration-primitives";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";

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
  onResetPassword
}: {
  user: AdministeredUser;
  canManageSuperadminAccess: boolean;
  canDeleteUser: boolean;
  mutating: boolean;
  onBack(): void;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
  onDeleteUser(userId: string): Promise<AdministeredUser>;
  onDeleted(): void;
  onUpsertIdentity(
    userId: string,
    input: UpsertAdministeredUserIdentityRequest
  ): Promise<AdministeredUser>;
  onDeleteIdentity(userId: string, identity: AdministeredUserIdentity): Promise<AdministeredUser>;
  onResetPassword(userId: string, password: string): Promise<unknown>;
}) {
  const canManageUser = canManageSuperadminAccess || !user.roles.includes("superadmin");
  const managementDisabledReason = canManageUser
    ? undefined
    : "Only superadmins can manage superadmin users.";

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
          All users
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
      setNotice({ kind: "success", text: "Changes saved." });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Profile</CardTitle>
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
              Save changes
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
      setNotice({ kind: "success", text: "Identity linked." });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  async function deleteIdentity(identity: AdministeredUserIdentity) {
    setNotice(undefined);
    try {
      await onDeleteIdentity(user.id, identity);
      setConfirmingKey(undefined);
      setNotice({ kind: "success", text: "Identity removed." });
    } catch (error) {
      setConfirmingKey(undefined);
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 size={17} aria-hidden="true" />
            Sign-in identities
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(disabledReason)}
            onClick={() => setFormOpen((open) => !open)}
          >
            <Plus size={15} aria-hidden="true" />
            Link identity
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">
          External auth systems can be linked here when password sign-in is not the right path.
        </p>
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
                    <Badge variant="outline">{identity.authSource}</Badge>
                    {identity.emailVerified ? <Badge variant="success">Verified</Badge> : null}
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
                      Remove
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingKey(undefined)}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${identity.authSource} identity`}
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
            <p className="text-sm text-muted-foreground">
              No identities yet — this user cannot sign in.
            </p>
          ) : null}
        </div>

        {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}

        {formOpen ? (
          <form className="grid gap-3 rounded-md border bg-muted/30 p-3" onSubmit={submit}>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Auth source">
                <Input
                  value={form.authSource}
                  placeholder="session-token"
                  onChange={(event) => setForm({ ...form, authSource: event.target.value })}
                />
              </Field>
              <Field label="External user id">
                <Input
                  value={form.externalUserId}
                  onChange={(event) => setForm({ ...form, externalUserId: event.target.value })}
                />
              </Field>
              <Field label="Display label">
                <Input
                  value={form.displayLabel}
                  onChange={(event) => setForm({ ...form, displayLabel: event.target.value })}
                />
              </Field>
              <Field label="Email">
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
              <span>Email verified</span>
            </label>
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={mutating || !form.authSource.trim() || !form.externalUserId.trim()}
              >
                <Link2 size={15} aria-hidden="true" />
                Save identity
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setFormOpen(false)}>
                Cancel
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
  onResetPassword
}: {
  user: AdministeredUser;
  disabledReason?: string;
  mutating: boolean;
  onResetPassword(userId: string, password: string): Promise<unknown>;
}) {
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
        text: hasPasswordIdentity
          ? "Password updated. The user was signed out everywhere."
          : "Password sign-in created."
      });
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound size={17} aria-hidden="true" />
          Password
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        <form className="grid gap-3" onSubmit={submit}>
          {!hasPasswordIdentity ? (
            <p className="text-sm text-muted-foreground">
              This user has no password sign-in yet. Creating one uses their profile email.
            </p>
          ) : null}
          {disabledReason ? (
            <p className="text-sm text-muted-foreground">{disabledReason}</p>
          ) : null}
          <Field
            label={hasPasswordIdentity ? "New password" : "Initial password"}
            hint={
              user.email
                ? "At least 8 characters. Share it with the user over a secure channel."
                : "Add an email in Profile before creating a password sign-in."
            }
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
                Generate
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
            {hasPasswordIdentity ? "Reset password" : "Create password sign-in"}
          </Button>
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
  onDeleteUser(userId: string): Promise<AdministeredUser>;
  onDeleted(): void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState<FormNoticeState>();
  const confirmationTarget = user.email ?? user.id;

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
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Delete account</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">
          Removes the user profile, sign-in identities, and standalone password access.
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
          Delete user
        </Button>
        <Dialog
          open={deleteOpen}
          title={`Delete ${user.displayLabel}?`}
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
              <p>
                This permanently removes the user profile, sign-in identities, and standalone
                password access. This cannot be undone.
              </p>
              <p>
                Type <strong className="font-mono text-foreground">{confirmationTarget}</strong> to
                confirm you are deleting the intended user.
              </p>
            </div>
            <Field label="Confirmation">
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
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={mutating || confirmation !== confirmationTarget}
              >
                <Trash2 size={16} aria-hidden="true" />
                {mutating ? "Deleting…" : "Permanently delete user"}
              </Button>
            </div>
          </form>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function AccountMetaCard({ user }: { user: AdministeredUser }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Account</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 p-4 pt-2 text-sm">
        <MetaRow
          label="User id"
          value={<span className="font-mono text-xs break-all">{user.id}</span>}
        />
        <MetaRow label="Created" value={formatDateTime(user.createdAt) ?? "—"} />
        <MetaRow label="Updated" value={formatDateTime(user.updatedAt) ?? "—"} />
        <MetaRow label="Last active" value={formatDateTime(user.lastAuthenticatedAt) ?? "Never"} />
      </CardContent>
    </Card>
  );
}

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0">{value}</span>
    </div>
  );
}
