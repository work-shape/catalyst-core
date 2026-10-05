import { useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, Copy, Search, UserPlus, Users } from "lucide-react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  DEFAULT_ROWS_PER_PAGE,
  accessLevelLabel,
  createEmptyCreateUserForm,
  distinctAuthSources,
  errorMessage,
  filterUsers,
  formToCreateInput,
  formatDateTime,
  roleFilterOptions,
  rolesToAccessLevel,
  type CreateUserFormState,
  type FormNoticeState,
  type UserStatusFilter
} from "./user-administration-model";
import { UserDetail } from "./user-administration-detail";
import { CreateUserFields, MaskedPasswordInput } from "./user-administration-fields";
import { Field, FormNotice, StatusBadge, UserAvatar } from "./user-administration-primitives";
import { UserPermissionOverview } from "./user-permission-overview";
import { useTranslation } from "../i18n";
import { cn } from "../ui/cn";
import { ControlPlanePage } from "./control-plane-page";

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
  /** Absent while invitation emails are unavailable for this client instance. */
  onSendInvitation?(userId: string): Promise<unknown>;
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
  onResetPassword,
  onSendInvitation
}: UserAdministrationPanelProps) {
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>();
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(DEFAULT_ROWS_PER_PAGE);
  const [createOpen, setCreateOpen] = useState(false);
  const [listView, setListView] = useState<"users" | "permissions">("users");
  const { t } = useTranslation();
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
        onSendInvitation={onSendInvitation}
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
    <ControlPlanePage
      title="Users"
      description={`${users.length.toLocaleString()} users · ${activeUserCount.toLocaleString()} active`}
      actions={
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <UserPlus size={16} aria-hidden="true" />
          New user
        </Button>
      }
    >
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
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border bg-card p-0.5">
          {(["users", "permissions"] as const).map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={listView === view}
              className={cn(
                "h-8 rounded-sm px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                listView === view && "bg-secondary text-secondary-foreground"
              )}
              onClick={() => setListView(view)}
            >
              {t(view === "users" ? "userListView" : "userRightsOverview")}
            </button>
          ))}
        </div>
      </div>

      {error ? <FormNotice notice={{ kind: "error", text: error }} /> : null}

      <Card className="overflow-hidden">
        {selectedRowIds.size > 0 && listView === "users" ? (
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
        ) : listView === "permissions" ? (
          <UserPermissionOverview users={visibleUsers} onSelectUser={setSelectedUserId} />
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

        {!loading && visibleUsers.length > 0 && listView === "users" ? (
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
              <span className="min-w-7 text-center text-sm font-semibold text-foreground">
                {currentPage}
              </span>
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
        onSendInvitation={onSendInvitation}
        onCreated={(user) => {
          setCreateOpen(false);
          setSelectedUserId(user.id);
        }}
      />
    </ControlPlanePage>
  );
}

function CreateUserDialog({
  open,
  canManageSuperadminAccess,
  mutating,
  onClose,
  onCreateUser,
  onSendInvitation,
  onCreated
}: {
  open: boolean;
  canManageSuperadminAccess: boolean;
  mutating: boolean;
  onClose(): void;
  onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
  onSendInvitation?(userId: string): Promise<unknown>;
  onCreated(user: AdministeredUser): void;
}) {
  const invitationsEnabled = Boolean(onSendInvitation);
  const [form, setForm] = useState<CreateUserFormState>(() =>
    createEmptyCreateUserForm(invitationsEnabled)
  );
  const [createdResult, setCreatedResult] = useState<{
    user: AdministeredUser;
    password?: string;
  }>();
  const [notice, setNotice] = useState<FormNoticeState>();

  useEffect(() => {
    if (open) {
      setForm(createEmptyCreateUserForm(invitationsEnabled));
      setCreatedResult(undefined);
      setNotice(undefined);
    }
  }, [open, invitationsEnabled]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(undefined);
    try {
      const created = await onCreateUser(formToCreateInput(form));
      if (form.sendInvitation && onSendInvitation) {
        setCreatedResult({ user: created });
        try {
          await onSendInvitation(created.id);
          setNotice({ kind: "success", text: "User created. The invitation email was sent." });
        } catch (error) {
          setNotice({
            kind: "error",
            text: `User created, but the invitation was not sent: ${errorMessage(error)} You can resend it from the user's page.`
          });
        }
        return;
      }
      if (form.createPasswordSignIn) {
        setCreatedResult({ user: created, password: form.password });
        setNotice({
          kind: "success",
          text: "User created. Share this password over a secure channel."
        });
        return;
      }
      setForm(createEmptyCreateUserForm(invitationsEnabled));
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
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void copyPassword()}
                >
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
          invitationsEnabled={invitationsEnabled}
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
              (form.sendInvitation
                ? !form.email.trim() || form.status !== "active"
                : form.createPasswordSignIn && (!form.email.trim() || form.password.length < 8))
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
