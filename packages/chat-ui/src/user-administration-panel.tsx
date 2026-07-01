import { useEffect, useState, type FocusEvent, type FormEvent, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Plus,
  Save,
  Search,
  Trash2,
  UserPlus,
  Users
} from "lucide-react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import {
  DEFAULT_ROWS_PER_PAGE,
  STANDALONE_AUTH_SOURCE,
  ACCESS_LEVEL_OPTIONS,
  accessLevelLabel,
  createEmptyCreateUserForm,
  distinctAuthSources,
  emptyIdentityForm,
  errorMessage,
  filterUsers,
  formToCreateInput,
  formToIdentityInput,
  formToUpdateInput,
  formatDateTime,
  generatePassword,
  roleFilterOptions,
  rolesToAccessLevel,
  userToForm,
  type CreateUserFormState,
  type FormNoticeState,
  type IdentityFormState,
  type UserFormState,
  type UserStatusFilter
} from "./user-administration-model";
import { Field, FormNotice, StatusBadge, UserAvatar } from "./user-administration-primitives";

interface UserAdministrationPanelProps {
  users: AdministeredUser[];
  loading: boolean;
  error?: string;
  canManageSuperadminAccess: boolean;
  mutating: boolean;
  onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
  onDeleteUser(userId: string): Promise<AdministeredUser>;
  onUpsertIdentity(
    userId: string,
    input: UpsertAdministeredUserIdentityRequest
  ): Promise<AdministeredUser>;
  onDeleteIdentity(userId: string, identity: AdministeredUserIdentity): Promise<AdministeredUser>;
  onResetPassword(userId: string, password: string): Promise<unknown>;
}

export function UserAdministrationPanel({
  users,
  loading,
  error,
  canManageSuperadminAccess,
  mutating,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onUpsertIdentity,
  onDeleteIdentity,
  onResetPassword
}: UserAdministrationPanelProps) {
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>();
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(DEFAULT_ROWS_PER_PAGE);
  const [createOpen, setCreateOpen] = useState(false);
  const selectedUser = users.find((user) => user.id === selectedUserId);

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, roleFilter, rowsPerPage]);

  useEffect(() => {
    const liveUserIds = new Set(users.map((user) => user.id));
    setSelectedRowIds((currentIds) => {
      const nextIds = new Set([...currentIds].filter((id) => liveUserIds.has(id)));
      return nextIds.size === currentIds.size ? currentIds : nextIds;
    });
  }, [users]);

  if (selectedUser) {
    return (
      <UserDetail
        user={selectedUser}
        canManageSuperadminAccess={canManageSuperadminAccess}
        canDeleteUser={canManageSuperadminAccess}
        mutating={mutating}
        onBack={() => setSelectedUserId(undefined)}
        onUpdateUser={onUpdateUser}
        onDeleteUser={onDeleteUser}
        onDeleted={() => setSelectedUserId(undefined)}
        onUpsertIdentity={onUpsertIdentity}
        onDeleteIdentity={onDeleteIdentity}
        onResetPassword={onResetPassword}
      />
    );
  }

  const roleOptions = roleFilterOptions(users);
  const visibleUsers = filterUsers(users, { search, statusFilter, roleFilter });
  const pageCount = Math.max(1, Math.ceil(visibleUsers.length / rowsPerPage));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * rowsPerPage;
  const pageUsers = visibleUsers.slice(pageStart, pageStart + rowsPerPage);
  const selectedPageCount = pageUsers.filter((user) => selectedRowIds.has(user.id)).length;
  const allPageRowsSelected = pageUsers.length > 0 && selectedPageCount === pageUsers.length;
  const activeUserCount = users.filter((user) => user.status === "active").length;

  function toggleRowSelection(userId: string, checked: boolean) {
    setSelectedRowIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (checked) {
        nextIds.add(userId);
      } else {
        nextIds.delete(userId);
      }
      return nextIds;
    });
  }

  function togglePageSelection(checked: boolean) {
    setSelectedRowIds((currentIds) => {
      const nextIds = new Set(currentIds);
      for (const user of pageUsers) {
        if (checked) {
          nextIds.add(user.id);
        } else {
          nextIds.delete(user.id);
        }
      }
      return nextIds;
    });
  }

  return (
    <div className="grid content-start gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h1 className="text-[22px] font-semibold tracking-normal text-foreground">Users</h1>
          <p className="text-sm text-muted-foreground">
            {users.length.toLocaleString()} users · {activeUserCount.toLocaleString()} active
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <UserPlus size={16} aria-hidden="true" />
          New user
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            className="pl-9"
            placeholder="Search users"
            aria-label="Search users"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          className="h-10 w-full font-medium sm:w-40"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as UserStatusFilter)}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </Select>
        <Select
          className="h-10 w-full font-medium sm:w-40"
          aria-label="Filter by role"
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value)}
        >
          <option value="all">All roles</option>
          {roleOptions.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </Select>
      </div>

      {error ? <FormNotice notice={{ kind: "error", text: error }} /> : null}

      <Card className="overflow-hidden">
        {selectedRowIds.size > 0 ? (
          <div className="flex flex-wrap items-center gap-3 border-b bg-primary/10 px-4 py-2.5">
            <span className="text-sm font-semibold text-primary">
              {selectedRowIds.size.toLocaleString()} selected
            </span>
            <div className="flex-1" />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-primary hover:bg-primary/15"
              onClick={() => setSelectedRowIds(new Set())}
            >
              Clear
            </Button>
          </div>
        ) : null}

        {loading ? (
          <CardContent className="p-4 text-sm text-muted-foreground">Loading users…</CardContent>
        ) : visibleUsers.length === 0 ? (
          <CardContent className="grid justify-items-center gap-2 p-8 text-center">
            <Users size={20} aria-hidden="true" className="text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {users.length === 0 ? "No users yet." : "No users match your search."}
            </p>
            {users.length === 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <UserPlus size={15} aria-hidden="true" />
                Create the first user
              </Button>
            ) : null}
          </CardContent>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-10 px-4">
                  <input
                    type="checkbox"
                    className="size-4 accent-sky-600"
                    aria-label="Select visible users"
                    checked={allPageRowsSelected}
                    onChange={(event) => togglePageSelection(event.target.checked)}
                  />
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] uppercase">
                  User
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] uppercase">
                  Access
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] uppercase">
                  Status
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] uppercase">
                  Sign-in methods
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] uppercase">
                  Last active
                </TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageUsers.map((user) => (
                <TableRow
                  key={user.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setSelectedUserId(user.id)}
                >
                  <TableCell className="px-4" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="size-4 accent-sky-600"
                      aria-label={`Select ${user.displayLabel}`}
                      checked={selectedRowIds.has(user.id)}
                      onChange={(event) => toggleRowSelection(user.id, event.target.checked)}
                    />
                  </TableCell>
                  <TableCell className="px-4">
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-3 text-left outline-none"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedUserId(user.id);
                      }}
                    >
                      <UserAvatar displayLabel={user.displayLabel} />
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate font-medium">{user.displayLabel}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {user.email ?? user.id}
                        </span>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="px-4">
                    <Badge variant="outline">
                      {accessLevelLabel(rolesToAccessLevel(user.roles))}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4">
                    <StatusBadge status={user.status} />
                  </TableCell>
                  <TableCell className="px-4 text-muted-foreground">
                    {user.identities.length > 0
                      ? distinctAuthSources(user.identities).join(", ")
                      : "None"}
                  </TableCell>
                  <TableCell className="px-4 whitespace-nowrap text-muted-foreground">
                    {formatDateTime(user.lastAuthenticatedAt) ?? "Never"}
                  </TableCell>
                  <TableCell className="px-4 text-muted-foreground">
                    <ChevronRight size={15} aria-hidden="true" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!loading && visibleUsers.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <div className="text-sm text-muted-foreground">
              {pageStart + 1}-{Math.min(pageStart + rowsPerPage, visibleUsers.length)} of{" "}
              {visibleUsers.length.toLocaleString()}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                Rows
                <Select
                  className="h-8 w-20 px-2 text-sm"
                  aria-label="Rows per page"
                  value={String(rowsPerPage)}
                  onChange={(event) => setRowsPerPage(Number(event.target.value))}
                >
                  <option value="10">10</option>
                  <option value="25">25</option>
                  <option value="50">50</option>
                </Select>
              </label>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-8"
                aria-label="Previous page"
                disabled={currentPage <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft size={15} aria-hidden="true" />
              </Button>
              <span className="min-w-7 text-center text-sm font-semibold text-foreground">{currentPage}</span>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-8"
                aria-label="Next page"
                disabled={currentPage >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              >
                <ChevronRight size={15} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <CreateUserDialog
        open={createOpen}
        canManageSuperadminAccess={canManageSuperadminAccess}
        mutating={mutating}
        onClose={() => setCreateOpen(false)}
        onCreateUser={onCreateUser}
        onCreated={(user) => {
          setCreateOpen(false);
          setSelectedUserId(user.id);
        }}
      />
    </div>
  );
}

function CreateUserDialog({
  open,
  canManageSuperadminAccess,
  mutating,
  onClose,
  onCreateUser,
  onCreated
}: {
  open: boolean;
  canManageSuperadminAccess: boolean;
  mutating: boolean;
  onClose(): void;
  onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
  onCreated(user: AdministeredUser): void;
}) {
  const [form, setForm] = useState<CreateUserFormState>(() => createEmptyCreateUserForm());
  const [createdResult, setCreatedResult] = useState<{
    user: AdministeredUser;
    password?: string;
  }>();
  const [notice, setNotice] = useState<FormNoticeState>();

  useEffect(() => {
    if (open) {
      setForm(createEmptyCreateUserForm());
      setCreatedResult(undefined);
      setNotice(undefined);
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    try {
      const created = await onCreateUser(formToCreateInput(form));
      if (form.createPasswordSignIn) {
        setCreatedResult({ user: created, password: form.password });
        setNotice({
          kind: "success",
          text: "User created. Share this password over a secure channel."
        });
        return;
      }
      setForm(createEmptyCreateUserForm());
      onCreated(created);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  async function copyPassword() {
    if (!createdResult?.password) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdResult.password);
      setNotice({ kind: "success", text: "Password copied." });
    } catch {
      setNotice({ kind: "error", text: "Password could not be copied automatically." });
    }
  }

  if (createdResult) {
    return (
      <Dialog open={open} title="User created" onClose={onClose}>
        <div className="grid gap-4">
          <div className="grid gap-1">
            <strong className="text-sm">{createdResult.user.displayLabel}</strong>
            <span className="text-sm text-muted-foreground">{createdResult.user.email}</span>
          </div>
          {createdResult.password ? (
            <Field label="Initial password" hint="This is only shown here. Share it securely.">
              <div className="flex gap-2">
                <MaskedPasswordInput
                  readOnly
                  value={createdResult.password}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button type="button" variant="outline" className="shrink-0" onClick={() => void copyPassword()}>
                  <Copy size={16} aria-hidden="true" />
                  Copy
                </Button>
              </div>
            </Field>
          ) : null}
          <FormNotice notice={notice} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button type="button" onClick={() => onCreated(createdResult.user)}>
              Open user
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} title="New user" onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        <CreateUserFields
          form={form}
          canManageSuperadminAccess={canManageSuperadminAccess}
          onChange={setForm}
        />
        <FormNotice notice={notice} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              mutating ||
              !form.displayLabel.trim() ||
              (form.createPasswordSignIn && (!form.email.trim() || form.password.length < 8))
            }
          >
            <UserPlus size={16} aria-hidden="true" />
            Create user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function UserDetail({
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
        <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
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
          {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}
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
                    {identity.emailVerified ? (
                      <Badge variant="success">Verified</Badge>
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
          {disabledReason ? <p className="text-sm text-muted-foreground">{disabledReason}</p> : null}
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
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<FormNoticeState>();

  useEffect(() => {
    setConfirming(false);
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
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="danger"
              disabled={mutating}
              onClick={() => void deleteUser()}
            >
              <Trash2 size={16} aria-hidden="true" />
              Delete user
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="w-fit text-destructive hover:text-destructive"
            disabled={mutating}
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={16} aria-hidden="true" />
            Delete user
          </Button>
        )}
        <FormNotice notice={notice} />
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
        <MetaRow label="User id" value={<span className="font-mono text-xs break-all">{user.id}</span>} />
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

function UserFields({
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
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Display label">
          <Input
            value={form.displayLabel}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, displayLabel: event.target.value })}
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            disabled={disabled}
            onChange={(event) => onChange({ ...form, email: event.target.value })}
          />
        </Field>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Status">
          <Select
            value={form.status}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...form, status: event.target.value as UserFormState["status"] })
            }
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
        <AccessLevelField
          value={form.accessLevel}
          canManageSuperadminAccess={canManageSuperadminAccess}
          disabled={disabled}
          onChange={(accessLevel) => onChange({ ...form, accessLevel })}
        />
        <Field label="Permission refs" hint="Comma-separated tool permissions">
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

function CreateUserFields({
  form,
  canManageSuperadminAccess,
  onChange
}: {
  form: CreateUserFormState;
  canManageSuperadminAccess: boolean;
  onChange(nextForm: CreateUserFormState): void;
}) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Display label">
          <Input
            value={form.displayLabel}
            onChange={(event) => onChange({ ...form, displayLabel: event.target.value })}
          />
        </Field>
        <Field label="Email" hint={form.createPasswordSignIn ? "Required for password sign-in." : undefined}>
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
        <Field label="Status">
          <Select
            value={form.status}
            onChange={(event) =>
              onChange({ ...form, status: event.target.value as CreateUserFormState["status"] })
            }
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
      </div>
      <label className="inline-flex w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.createPasswordSignIn}
          onChange={(event) => onChange({ ...form, createPasswordSignIn: event.target.checked })}
        />
        <span>Create password sign-in</span>
      </label>
      {form.createPasswordSignIn ? (
        <Field label="Initial password" hint="At least 8 characters. Share it with the user securely.">
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
              Generate
            </Button>
          </div>
        </Field>
      ) : null}
      <details className="rounded-md border bg-muted/20 p-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced permissions</summary>
        <div className="mt-3">
          <Field label="Permission refs" hint="Comma-separated tool permissions">
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

function MaskedPasswordInput({
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
        aria-label={visible ? "Hide password" : "Show password"}
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
  const selected = ACCESS_LEVEL_OPTIONS.find((option) => option.value === value);
  const options = ACCESS_LEVEL_OPTIONS.filter(
    (option) => canManageSuperadminAccess || option.value !== "superadmin" || value === "superadmin"
  );
  return (
    <Field label="Access level" hint={selected?.description}>
      <Select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as typeof value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}
