import { useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, Copy, Search, UserPlus, Users } from "lucide-react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  FilterBar,
  Input,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@vivd-catalyst/ui";
import {
  DEFAULT_ROWS_PER_PAGE,
  accessLevelLabel,
  createEmptyCreateUserForm,
  distinctAuthSources,
  errorMessage,
  filterUsers,
  formToCreateInput,
  roleFilterOptions,
  roleLabel,
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
import { ControlPlanePage } from "./control-plane-page";
import { formatDateTime } from "./locale-format";

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
  const { t, locale } = useTranslation();
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
      title={t("administrationUsers")}
      description={t("settings.usersSummary", {
        total: users.length.toLocaleString(locale),
        active: activeUserCount.toLocaleString(locale)
      })}
      actions={
        <Button type="button" onClick={() => setCreateOpen(true)}>
          <UserPlus size={16} aria-hidden="true" />
          {t("settings.userNew")}
        </Button>
      }
    >
      <FilterBar
        search={
          <Input
            type="search"
            leadingIcon={<Search aria-hidden="true" />}
            placeholder={t("settings.userSearch")}
            aria-label={t("settings.userSearch")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        }
        filters={
          <>
            <Select
              className="w-full font-medium sm:w-40"
              aria-label={t("settings.userFilterByStatus")}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as UserStatusFilter)}
            >
              <option value="all">{t("allStatuses")}</option>
              <option value="active">{t("settings.statusActive")}</option>
              <option value="disabled">{t("settings.statusDisabled")}</option>
            </Select>
            <Select
              className="w-full font-medium sm:w-40"
              aria-label={t("settings.userFilterByRole")}
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value)}
            >
              <option value="all">{t("settings.userAllRoles")}</option>
              {roleOptions.map((role) => {
                const label = roleLabel(role);
                return (
                  <option key={role} value={role}>
                    {label ? t(label) : role}
                  </option>
                );
              })}
            </Select>
          </>
        }
        actions={
          <SegmentedControl
            label={t("userListViewChoice")}
            value={listView}
            onValueChange={(value) =>
              setListView(value === "permissions" ? "permissions" : "users")
            }
          >
            <SegmentedControlItem value="users">{t("userListView")}</SegmentedControlItem>
            <SegmentedControlItem value="permissions">
              {t("userRightsOverview")}
            </SegmentedControlItem>
          </SegmentedControl>
        }
      />

      {error ? <FormNotice notice={{ kind: "error", text: error }} /> : null}

      <Card className="overflow-hidden">
        {selectedRowIds.size > 0 && listView === "users" ? (
          <div className="flex flex-wrap items-center gap-3 border-b bg-primary/10 px-4 py-2.5">
            <span className="text-sm font-semibold text-primary">
              {t("settings.userSelectedCount", {
                count: selectedRowIds.size.toLocaleString(locale)
              })}
            </span>
            <div className="flex-1" />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-primary hover:bg-primary/15"
              onClick={() => setSelectedRowIds(new Set())}
            >
              {t("settings.userClearSelection")}
            </Button>
          </div>
        ) : null}

        {loading ? (
          <CardContent className="p-4 text-sm text-muted-foreground">
            {t("settings.usersLoading")}
          </CardContent>
        ) : visibleUsers.length === 0 ? (
          <CardContent className="grid justify-items-center gap-2 p-8 text-center">
            <Users size={20} aria-hidden="true" className="text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t(users.length === 0 ? "settings.usersEmpty" : "settings.usersNoMatch")}
            </p>
            {users.length === 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <UserPlus size={15} aria-hidden="true" />
                {t("settings.userCreateFirst")}
              </Button>
            ) : null}
          </CardContent>
        ) : listView === "permissions" ? (
          <UserPermissionOverview users={visibleUsers} onSelectUser={setSelectedUserId} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 px-4">
                  <input
                    type="checkbox"
                    className="size-4 accent-sky-600"
                    aria-label={t("settings.userSelectVisible")}
                    checked={allPageRowsSelected}
                    onChange={(event) => togglePageSelection(event.target.checked)}
                  />
                </TableHead>
                <TableHead className="px-4">{t("userRightsOverviewUser")}</TableHead>
                <TableHead className="px-4">{t("settings.userAccess")}</TableHead>
                <TableHead className="px-4">{t("settings.status")}</TableHead>
                <TableHead className="px-4">{t("settings.userSignInMethods")}</TableHead>
                <TableHead className="px-4">{t("settings.userLastActive")}</TableHead>
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
                      aria-label={t("settings.userSelect", { name: user.displayLabel })}
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
                    <Badge appearance="outline">
                      {t(accessLevelLabel(rolesToAccessLevel(user.roles)))}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4">
                    <StatusBadge status={user.status} />
                  </TableCell>
                  <TableCell className="px-4 text-muted-foreground">
                    {user.identities.length > 0
                      ? distinctAuthSources(user.identities).join(", ")
                      : t("settings.userSignInMethodsNone")}
                  </TableCell>
                  <TableCell className="px-4 whitespace-nowrap text-muted-foreground">
                    {user.lastAuthenticatedAt
                      ? formatDateTime(user.lastAuthenticatedAt, locale)
                      : t("settings.never")}
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
              {t("settings.paginationRange", {
                from: pageStart + 1,
                to: Math.min(pageStart + rowsPerPage, visibleUsers.length),
                total: visibleUsers.length.toLocaleString(locale)
              })}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                {t("settings.paginationRows")}
                <Select
                  className="h-8 w-20 px-2 text-sm"
                  aria-label={t("settings.paginationRowsPerPage")}
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
                aria-label={t("settings.paginationPrevious")}
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
                aria-label={t("settings.paginationNext")}
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
  const { t } = useTranslation();
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
          setNotice({ kind: "success", text: t("settings.userCreatedInvitationSent") });
        } catch (error) {
          setNotice({
            kind: "error",
            text: t("settings.userCreatedInvitationFailed", {
              error: errorMessage(error, t("settings.requestFailed"))
            })
          });
        }
        return;
      }
      if (form.createPasswordSignIn) {
        setCreatedResult({ user: created, password: form.password });
        setNotice({
          kind: "success",
          text: t("settings.userCreatedSharePassword")
        });
        return;
      }
      setForm(createEmptyCreateUserForm(invitationsEnabled));
      onCreated(created);
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error, t("settings.requestFailed")) });
    }
  }

  async function copyPassword() {
    if (!createdResult?.password) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdResult.password);
      setNotice({ kind: "success", text: t("settings.userPasswordCopied") });
    } catch {
      setNotice({ kind: "error", text: t("settings.userPasswordCopyFailed") });
    }
  }

  if (createdResult) {
    return (
      <Dialog open={open} title={t("settings.userCreated")} onClose={onClose}>
        <div className="grid gap-4">
          <div className="grid gap-1">
            <strong className="text-sm">{createdResult.user.displayLabel}</strong>
            <span className="text-sm text-muted-foreground">{createdResult.user.email}</span>
          </div>
          {createdResult.password ? (
            <Field
              label={t("settings.passwordInitial")}
              hint={t("settings.userInitialPasswordShownOnce")}
            >
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
                  {t("copy")}
                </Button>
              </div>
            </Field>
          ) : null}
          <FormNotice notice={notice} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("close")}
            </Button>
            <Button type="button" onClick={() => onCreated(createdResult.user)}>
              {t("settings.userOpen")}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} title={t("settings.userNew")} onClose={onClose}>
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
            {t("cancel")}
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
            {t("settings.userCreate")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
