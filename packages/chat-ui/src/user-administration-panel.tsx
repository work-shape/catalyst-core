import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
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
} from "@agent-chat-platform/api-client";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { cn } from "./ui/cn";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { avatarGradient } from "./avatar-gradient";

/** Auth source id of the standalone Better Auth adapter; only those identities have passwords. */
const STANDALONE_AUTH_SOURCE = "better-auth";

interface UserAdministrationPanelProps {
  users: AdministeredUser[];
  loading: boolean;
  error?: string;
  mutating: boolean;
  onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
  onUpsertIdentity(
    userId: string,
    input: UpsertAdministeredUserIdentityRequest
  ): Promise<AdministeredUser>;
  onDeleteIdentity(userId: string, identity: AdministeredUserIdentity): Promise<AdministeredUser>;
  onResetPassword(userId: string, password: string): Promise<unknown>;
}

interface UserFormState {
  displayLabel: string;
  email: string;
  roles: string;
  permissionRefs: string;
  status: AdministeredUser["status"];
}

interface IdentityFormState {
  authSource: string;
  externalUserId: string;
  displayLabel: string;
  email: string;
  emailVerified: boolean;
}

type FormNoticeState = { kind: "success" | "error"; text: string } | undefined;

const emptyUserForm: UserFormState = {
  displayLabel: "",
  email: "",
  roles: "user",
  permissionRefs: "",
  status: "active"
};

const emptyIdentityForm: IdentityFormState = {
  authSource: "session-token",
  externalUserId: "",
  displayLabel: "",
  email: "",
  emailVerified: false
};

type UserStatusFilter = "all" | AdministeredUser["status"];

const DEFAULT_ROWS_PER_PAGE = 10;
const ROLE_ORDER = ["superadmin", "admin", "user"];

export function UserAdministrationPanel({
  users,
  loading,
  error,
  mutating,
  onCreateUser,
  onUpdateUser,
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
        mutating={mutating}
        onBack={() => setSelectedUserId(undefined)}
        onUpdateUser={onUpdateUser}
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
                  Roles
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
                    <span className="flex flex-wrap gap-1">
                      {user.roles.length > 0 ? (
                        user.roles.map((role) => (
                          <Badge key={role} variant="outline">
                            {role}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
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
  mutating,
  onClose,
  onCreateUser,
  onCreated
}: {
  open: boolean;
  mutating: boolean;
  onClose(): void;
  onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
  onCreated(user: AdministeredUser): void;
}) {
  const [form, setForm] = useState<UserFormState>(emptyUserForm);
  const [notice, setNotice] = useState<FormNoticeState>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    try {
      const created = await onCreateUser(formToCreateInput(form));
      setForm(emptyUserForm);
      onCreated(created);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  return (
    <Dialog open={open} title="New user" onClose={onClose}>
      <form className="grid gap-3" onSubmit={submit}>
        <UserFields form={form} onChange={setForm} />
        <FormNotice notice={notice} />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutating || !form.displayLabel.trim()}>
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
  mutating,
  onBack,
  onUpdateUser,
  onUpsertIdentity,
  onDeleteIdentity,
  onResetPassword
}: {
  user: AdministeredUser;
  mutating: boolean;
  onBack(): void;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
  onUpsertIdentity(
    userId: string,
    input: UpsertAdministeredUserIdentityRequest
  ): Promise<AdministeredUser>;
  onDeleteIdentity(userId: string, identity: AdministeredUserIdentity): Promise<AdministeredUser>;
  onResetPassword(userId: string, password: string): Promise<unknown>;
}) {
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
          <ProfileCard user={user} mutating={mutating} onUpdateUser={onUpdateUser} />
          <IdentitiesCard
            user={user}
            mutating={mutating}
            onUpsertIdentity={onUpsertIdentity}
            onDeleteIdentity={onDeleteIdentity}
          />
        </div>
        <div className="grid content-start gap-4">
          <PasswordCard user={user} mutating={mutating} onResetPassword={onResetPassword} />
          <AccountMetaCard user={user} />
        </div>
      </div>
    </div>
  );
}

function ProfileCard({
  user,
  mutating,
  onUpdateUser
}: {
  user: AdministeredUser;
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
          <UserFields form={form} onChange={setForm} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={mutating || !form.displayLabel.trim()}>
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
  mutating,
  onUpsertIdentity,
  onDeleteIdentity
}: {
  user: AdministeredUser;
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
            onClick={() => setFormOpen((open) => !open)}
          >
            <Plus size={15} aria-hidden="true" />
            Link identity
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-2">
        <p className="text-sm text-muted-foreground">
          Identities connect this user to the auth systems they can sign in with.
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
                      disabled={mutating}
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
                    disabled={mutating}
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
  mutating,
  onResetPassword
}: {
  user: AdministeredUser;
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
        text: "Password updated. The user was signed out everywhere."
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
        {hasPasswordIdentity ? (
          <form className="grid gap-3" onSubmit={submit}>
            <Field
              label="New password"
              hint="At least 8 characters. Share it with the user over a secure channel."
            >
              <div className="flex gap-2">
                <Input
                  value={password}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setPassword(generatePassword())}
                >
                  Generate
                </Button>
              </div>
            </Field>
            <Button type="submit" disabled={mutating || password.length < 8}>
              <KeyRound size={16} aria-hidden="true" />
              Reset password
            </Button>
            <FormNotice notice={notice} />
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            This user has no password sign-in. Link a {STANDALONE_AUTH_SOURCE} identity to manage a
            password.
          </p>
        )}
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
  onChange
}: {
  form: UserFormState;
  onChange(nextForm: UserFormState): void;
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
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(event) => onChange({ ...form, email: event.target.value })}
          />
        </Field>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Status">
          <Select
            value={form.status}
            onChange={(event) =>
              onChange({ ...form, status: event.target.value as UserFormState["status"] })
            }
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
        <Field label="Roles" hint="Comma-separated: user, admin, superadmin">
          <Input
            value={form.roles}
            onChange={(event) => onChange({ ...form, roles: event.target.value })}
          />
        </Field>
        <Field label="Permission refs" hint="Comma-separated tool permissions">
          <Input
            value={form.permissionRefs}
            onChange={(event) => onChange({ ...form, permissionRefs: event.target.value })}
          />
        </Field>
      </div>
    </>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid content-start gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground/80">{hint}</span> : null}
    </label>
  );
}

function FormNotice({ notice }: { notice: FormNoticeState }) {
  if (!notice) {
    return null;
  }
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-1.5 text-sm",
        notice.kind === "error" ? "text-destructive" : "text-emerald-700"
      )}
    >
      {notice.kind === "error" ? (
        <AlertCircle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      ) : (
        <CheckCircle2 size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      )}
      <span>{notice.text}</span>
    </p>
  );
}

function UserAvatar({ displayLabel, size = "md" }: { displayLabel: string; size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      style={{ background: avatarGradient(displayLabel) }}
      className={cn(
        "grid shrink-0 place-items-center font-semibold text-white shadow-sm ring-1 ring-white/45",
        size === "lg" ? "size-11 rounded-[11px] text-sm" : "size-8 rounded-[9px] text-xs"
      )}
    >
      {initials(displayLabel)}
    </span>
  );
}

function StatusBadge({ status }: { status: AdministeredUser["status"] }) {
  return (
    <Badge variant={status === "active" ? "success" : "outline"} className="capitalize">
      {status}
    </Badge>
  );
}

function filterUsers(
  users: AdministeredUser[],
  filters: {
    search: string;
    statusFilter: UserStatusFilter;
    roleFilter: string;
  }
): AdministeredUser[] {
  const query = filters.search.trim().toLowerCase();
  return users.filter((user) => {
    if (query && ![user.displayLabel, user.email ?? "", ...user.roles].join(" ").toLowerCase().includes(query)) {
      return false;
    }
    if (filters.statusFilter !== "all" && user.status !== filters.statusFilter) {
      return false;
    }
    if (filters.roleFilter !== "all" && !user.roles.includes(filters.roleFilter)) {
      return false;
    }
    return true;
  });
}

function roleFilterOptions(users: AdministeredUser[]): string[] {
  return [...new Set(users.flatMap((user) => user.roles))].sort((left, right) => {
    const leftIndex = ROLE_ORDER.indexOf(left);
    const rightIndex = ROLE_ORDER.indexOf(right);

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? ROLE_ORDER.length : leftIndex) - (rightIndex === -1 ? ROLE_ORDER.length : rightIndex);
    }

    return left.localeCompare(right);
  });
}

function distinctAuthSources(identities: AdministeredUserIdentity[]): string[] {
  return [...new Set(identities.map((identity) => identity.authSource))];
}

function initials(displayLabel: string): string {
  const parts = displayLabel.trim().split(/\s+/u).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

function formatDateTime(value: string | undefined): string | undefined {
  return value ? new Date(value).toLocaleString() : undefined;
}

function generatePassword(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Request failed";
}

function userToForm(user: AdministeredUser): UserFormState {
  return {
    displayLabel: user.displayLabel,
    email: user.email ?? "",
    roles: formatList(user.roles),
    permissionRefs: formatList(user.permissionRefs),
    status: user.status
  };
}

function formToCreateInput(form: UserFormState): CreateAdministeredUserRequest {
  return {
    displayLabel: form.displayLabel.trim(),
    email: optionalText(form.email),
    roles: parseList(form.roles),
    permissionRefs: parseList(form.permissionRefs),
    status: form.status
  };
}

function formToUpdateInput(form: UserFormState): UpdateAdministeredUserRequest {
  return {
    displayLabel: form.displayLabel.trim(),
    email: form.email.trim() ? form.email.trim() : null,
    roles: parseList(form.roles),
    permissionRefs: parseList(form.permissionRefs),
    status: form.status
  };
}

function formToIdentityInput(form: IdentityFormState): UpsertAdministeredUserIdentityRequest {
  return {
    authSource: form.authSource.trim(),
    externalUserId: form.externalUserId.trim(),
    displayLabel: optionalText(form.displayLabel),
    email: optionalText(form.email),
    emailVerified: form.emailVerified
  };
}

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatList(value: string[]): string {
  return value.join(", ");
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
