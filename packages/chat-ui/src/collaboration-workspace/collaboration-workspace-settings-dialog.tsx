import { LogOut, Trash2, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CollaborationWorkspaceWithRole,
  WorkspaceAccessRequestItem,
  WorkspaceMember,
  WorkspaceMembershipRole
} from "@vivd-catalyst/api-client";
import { useTranslation, type TranslationKey } from "../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Dialog } from "../ui/dialog";
import { Input, Textarea } from "../ui/input";
import { Select } from "../ui/select";
import {
  resolveCollaborationWorkspaceAccentColor,
  type CollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";
import {
  CollaborationWorkspaceAvatar,
  collaborationWorkspaceInitials
} from "./collaboration-workspace-avatar";
import {
  CollaborationWorkspaceAccentField,
  CollaborationWorkspaceEmojiField,
  CollaborationWorkspaceVisibilityField,
  type CollaborationWorkspaceVisibility
} from "./collaboration-workspace-fields";

export interface CollaborationWorkspaceSettingsValues {
  name: string;
  description: string | null;
  visibility: CollaborationWorkspaceVisibility;
  emoji: string | null;
  accentColor: CollaborationWorkspaceAccentColor;
}

export type CollaborationWorkspaceSettingsTab = "general" | "members" | "requests";

const settingsTabs: Array<{ id: CollaborationWorkspaceSettingsTab; label: TranslationKey }> = [
  { id: "general", label: "collaborationWorkspaceTabGeneral" },
  { id: "members", label: "collaborationWorkspaceTabMembers" },
  { id: "requests", label: "collaborationWorkspaceTabRequests" }
];

const roleLabelKeys: Record<WorkspaceMembershipRole, TranslationKey> = {
  owner: "collaborationWorkspaceRoleOwner",
  admin: "collaborationWorkspaceRoleAdmin",
  member: "collaborationWorkspaceRoleMember"
};

export function CollaborationWorkspaceSettingsDialog({
  open,
  collaborationWorkspace,
  currentUserId,
  members,
  membersLoading,
  membersLoadFailed,
  accessRequests,
  accessRequestsLoading,
  accessRequestsLoadFailed,
  savePending,
  membershipPending,
  errorMessage,
  onClose,
  onSave,
  onAddMember,
  onChangeMemberRole,
  onRemoveMember,
  onLeave,
  onApproveAccessRequest,
  onDeclineAccessRequest
}: {
  open: boolean;
  collaborationWorkspace: CollaborationWorkspaceWithRole;
  currentUserId: string | undefined;
  members: WorkspaceMember[];
  membersLoading: boolean;
  membersLoadFailed: boolean;
  accessRequests: WorkspaceAccessRequestItem[];
  accessRequestsLoading: boolean;
  accessRequestsLoadFailed: boolean;
  savePending: boolean;
  membershipPending: boolean;
  errorMessage: string | undefined;
  onClose(): void;
  onSave(values: CollaborationWorkspaceSettingsValues): void;
  onAddMember(email: string): void;
  onChangeMemberRole(userId: string, role: WorkspaceMembershipRole): void;
  onRemoveMember(userId: string): void;
  onLeave(): void;
  onApproveAccessRequest(userId: string): void;
  onDeclineAccessRequest(userId: string): void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CollaborationWorkspaceSettingsTab>("general");
  const tabRefs = useRef<Partial<Record<CollaborationWorkspaceSettingsTab, HTMLButtonElement>>>({});

  useEffect(() => {
    if (!open) {
      setTab("general");
    }
  }, [open]);

  function selectTabByOffset(offset: number) {
    const currentIndex = settingsTabs.findIndex((candidate) => candidate.id === tab);
    const nextTab =
      settingsTabs[(currentIndex + offset + settingsTabs.length) % settingsTabs.length];
    if (nextTab) {
      setTab(nextTab.id);
      tabRefs.current[nextTab.id]?.focus();
    }
  }

  return (
    <Dialog
      open={open}
      title={t("collaborationWorkspaceSettingsTitle")}
      className="w-[min(44rem,calc(100vw-2rem))]"
      onClose={onClose}
    >
      <div className="grid gap-5">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
          <CollaborationWorkspaceAvatar
            name={collaborationWorkspace.name}
            emoji={collaborationWorkspace.emoji}
            accentColor={collaborationWorkspace.accentColor}
            size="lg"
          />
          <div className="grid min-w-0 gap-1">
            <strong className="truncate text-sm font-semibold">
              {collaborationWorkspace.name}
            </strong>
            <span className="text-xs text-muted-foreground">
              {t(roleLabelKeys[collaborationWorkspace.role])}
            </span>
          </div>
        </div>

        <div
          role="tablist"
          aria-label={t("collaborationWorkspaceSettingsTitle")}
          className="flex gap-1 border-b"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              selectTabByOffset(1);
            }
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              selectTabByOffset(-1);
            }
          }}
        >
          {settingsTabs.map((candidate) => (
            <button
              key={candidate.id}
              ref={(element) => {
                if (element) {
                  tabRefs.current[candidate.id] = element;
                }
              }}
              type="button"
              role="tab"
              id={`collaboration-workspace-tab-${candidate.id}`}
              aria-controls={`collaboration-workspace-panel-${candidate.id}`}
              aria-selected={tab === candidate.id}
              tabIndex={tab === candidate.id ? 0 : -1}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/40",
                tab === candidate.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setTab(candidate.id)}
            >
              {candidate.id === "requests"
                ? t(candidate.label, { count: accessRequests.length })
                : t(candidate.label)}
            </button>
          ))}
        </div>

        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}

        <div
          role="tabpanel"
          id={`collaboration-workspace-panel-${tab}`}
          aria-labelledby={`collaboration-workspace-tab-${tab}`}
        >
          {tab === "general" ? (
            <CollaborationWorkspaceGeneralTab
              collaborationWorkspace={collaborationWorkspace}
              currentUserId={currentUserId}
              members={members}
              savePending={savePending}
              membershipPending={membershipPending}
              onSave={onSave}
              onLeave={onLeave}
            />
          ) : null}
          {tab === "members" ? (
            <CollaborationWorkspaceMembersTab
              collaborationWorkspace={collaborationWorkspace}
              currentUserId={currentUserId}
              members={members}
              loading={membersLoading}
              loadFailed={membersLoadFailed}
              pending={membershipPending}
              onAddMember={onAddMember}
              onChangeMemberRole={onChangeMemberRole}
              onRemoveMember={onRemoveMember}
            />
          ) : null}
          {tab === "requests" ? (
            <CollaborationWorkspaceRequestsTab
              accessRequests={accessRequests}
              loading={accessRequestsLoading}
              loadFailed={accessRequestsLoadFailed}
              pending={membershipPending}
              onApprove={onApproveAccessRequest}
              onDecline={onDeclineAccessRequest}
            />
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

export function CollaborationWorkspaceGeneralTab({
  collaborationWorkspace,
  currentUserId,
  members,
  savePending,
  membershipPending,
  onSave,
  onLeave
}: {
  collaborationWorkspace: CollaborationWorkspaceWithRole;
  currentUserId: string | undefined;
  members: WorkspaceMember[];
  savePending: boolean;
  membershipPending: boolean;
  onSave(values: CollaborationWorkspaceSettingsValues): void;
  onLeave(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(collaborationWorkspace.name);
  const [description, setDescription] = useState(collaborationWorkspace.description ?? "");
  const [emoji, setEmoji] = useState(collaborationWorkspace.emoji ?? "");
  const [visibility, setVisibility] = useState<CollaborationWorkspaceVisibility>(
    collaborationWorkspace.visibility
  );
  const [accentColor, setAccentColor] = useState<CollaborationWorkspaceAccentColor>(
    resolveCollaborationWorkspaceAccentColor(collaborationWorkspace)
  );
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);
  const trimmedName = name.trim();
  const otherOwnerExists = members.some(
    (member) => member.role === "owner" && member.userId !== currentUserId
  );
  const canLeave = collaborationWorkspace.role !== "owner" || otherOwnerExists;

  useEffect(() => {
    setName(collaborationWorkspace.name);
    setDescription(collaborationWorkspace.description ?? "");
    setEmoji(collaborationWorkspace.emoji ?? "");
    setVisibility(collaborationWorkspace.visibility);
    setAccentColor(resolveCollaborationWorkspaceAccentColor(collaborationWorkspace));
  }, [collaborationWorkspace]);

  return (
    <>
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmedName || savePending) {
            return;
          }
          onSave({
            name: trimmedName,
            description: description.trim() ? description.trim() : null,
            visibility,
            emoji: emoji.trim() ? emoji.trim() : null,
            accentColor
          });
        }}
      >
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="collaboration-workspace-settings-name">
            {t("collaborationWorkspaceNameLabel")}
          </label>
          <Input
            id="collaboration-workspace-settings-name"
            value={name}
            maxLength={120}
            disabled={savePending}
            aria-invalid={trimmedName ? undefined : true}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </div>

        <div className="grid gap-2">
          <label
            className="text-sm font-medium"
            htmlFor="collaboration-workspace-settings-description"
          >
            {t("collaborationWorkspaceDescriptionLabel")}
          </label>
          <Textarea
            id="collaboration-workspace-settings-description"
            value={description}
            maxLength={500}
            disabled={savePending}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("collaborationWorkspaceDescriptionHint")}
          </p>
        </div>

        <CollaborationWorkspaceVisibilityField
          value={visibility}
          disabled={savePending}
          onChange={setVisibility}
        />
        <CollaborationWorkspaceEmojiField
          value={emoji}
          disabled={savePending}
          onChange={setEmoji}
        />
        <CollaborationWorkspaceAccentField
          value={accentColor}
          disabled={savePending}
          onChange={setAccentColor}
        />

        <div className="flex justify-end">
          <Button type="submit" disabled={savePending || !trimmedName}>
            {savePending ? t("saving") : t("configSaveChanges")}
          </Button>
        </div>
      </form>

      <div className="mt-6 grid gap-2 border-t pt-5">
        <Button
          type="button"
          variant="ghost"
          className="h-9 w-fit justify-start text-destructive hover:bg-destructive/10"
          disabled={!canLeave || membershipPending}
          title={canLeave ? undefined : t("collaborationWorkspaceErrorLastOwner")}
          onClick={() => setConfirmLeaveOpen(true)}
        >
          <LogOut size={16} aria-hidden="true" />
          <span>{t("collaborationWorkspaceLeave")}</span>
        </Button>
        {canLeave ? null : (
          <p className="text-xs text-muted-foreground">
            {t("collaborationWorkspaceErrorLastOwner")}
          </p>
        )}
      </div>

      <Dialog
        open={confirmLeaveOpen}
        title={t("collaborationWorkspaceLeaveTitle")}
        onClose={() => setConfirmLeaveOpen(false)}
      >
        <div className="grid gap-4">
          <p className="text-sm leading-6 text-muted-foreground">
            {t("collaborationWorkspaceLeaveDescription", { name: collaborationWorkspace.name })}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirmLeaveOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={membershipPending}
              onClick={() => {
                setConfirmLeaveOpen(false);
                onLeave();
              }}
            >
              {membershipPending
                ? t("collaborationWorkspaceLeaving")
                : t("collaborationWorkspaceLeaveConfirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function CollaborationWorkspaceMembersTab({
  collaborationWorkspace,
  currentUserId,
  members,
  loading,
  loadFailed,
  pending,
  onAddMember,
  onChangeMemberRole,
  onRemoveMember
}: {
  collaborationWorkspace: CollaborationWorkspaceWithRole;
  currentUserId: string | undefined;
  members: WorkspaceMember[];
  loading: boolean;
  loadFailed: boolean;
  pending: boolean;
  onAddMember(email: string): void;
  onChangeMemberRole(userId: string, role: WorkspaceMembershipRole): void;
  onRemoveMember(userId: string): void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [memberPendingRemoval, setMemberPendingRemoval] = useState<WorkspaceMember | undefined>();
  const actorRole = collaborationWorkspace.role;

  return (
    <div className="grid gap-5">
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmedEmail = email.trim();
          if (!trimmedEmail || pending) {
            return;
          }
          onAddMember(trimmedEmail);
          setEmail("");
        }}
      >
        <label className="text-sm font-medium" htmlFor="collaboration-workspace-member-email">
          {t("collaborationWorkspaceAddMemberLabel")}
        </label>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <Input
            id="collaboration-workspace-member-email"
            type="email"
            value={email}
            disabled={pending}
            placeholder={t("collaborationWorkspaceAddMemberPlaceholder")}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
          <Button type="submit" variant="outline" disabled={pending}>
            <UserPlus size={16} aria-hidden="true" />
            {t("collaborationWorkspaceAddMemberSubmit")}
          </Button>
        </div>
      </form>

      {loadFailed ? (
        <p className="text-sm text-destructive">{t("collaborationWorkspaceMembersLoadFailed")}</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">{t("collaborationWorkspaceMembersLoading")}</p>
      ) : (
        <ul className="grid gap-2">
          {members.map((member) => {
            const isSelf = member.userId === currentUserId;
            return (
              <li
                key={member.userId}
                data-testid="collaboration-workspace-member-row"
                className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md border p-3"
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-xs font-semibold text-secondary-foreground"
                  aria-hidden="true"
                >
                  {collaborationWorkspaceInitials(member.displayLabel)}
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-sm font-medium">{member.displayLabel}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {member.email ?? ""}
                  </span>
                </span>
                {canChangeCollaborationWorkspaceRole(actorRole) ? (
                  <Select
                    className="h-9 w-36"
                    value={member.role}
                    disabled={pending}
                    aria-label={t("collaborationWorkspaceRoleLabel", {
                      name: member.displayLabel
                    })}
                    onChange={(event) =>
                      onChangeMemberRole(
                        member.userId,
                        event.currentTarget.value as WorkspaceMembershipRole
                      )
                    }
                  >
                    <option value="owner">{t("collaborationWorkspaceRoleOwner")}</option>
                    <option value="admin">{t("collaborationWorkspaceRoleAdmin")}</option>
                    <option value="member">{t("collaborationWorkspaceRoleMember")}</option>
                  </Select>
                ) : (
                  <Badge variant="secondary">{t(roleLabelKeys[member.role])}</Badge>
                )}
                {!isSelf && canRemoveCollaborationWorkspaceMember(actorRole, member.role) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    disabled={pending}
                    aria-label={t("collaborationWorkspaceRemoveMember", {
                      name: member.displayLabel
                    })}
                    title={t("collaborationWorkspaceRemoveMember", { name: member.displayLabel })}
                    onClick={() => setMemberPendingRemoval(member)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </Button>
                ) : (
                  <span aria-hidden="true" className="size-8" />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={Boolean(memberPendingRemoval)}
        title={t("collaborationWorkspaceRemoveMemberTitle")}
        onClose={() => setMemberPendingRemoval(undefined)}
      >
        <div className="grid gap-4">
          <p className="text-sm leading-6 text-muted-foreground">
            {t("collaborationWorkspaceRemoveMemberDescription", {
              name: memberPendingRemoval?.displayLabel ?? ""
            })}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setMemberPendingRemoval(undefined)}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() => {
                const member = memberPendingRemoval;
                setMemberPendingRemoval(undefined);
                if (member) {
                  onRemoveMember(member.userId);
                }
              }}
            >
              <Trash2 size={16} aria-hidden="true" />
              {t("collaborationWorkspaceRemoveMemberConfirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

export function CollaborationWorkspaceRequestsTab({
  accessRequests,
  loading,
  loadFailed,
  pending,
  onApprove,
  onDecline
}: {
  accessRequests: WorkspaceAccessRequestItem[];
  loading: boolean;
  loadFailed: boolean;
  pending: boolean;
  onApprove(userId: string): void;
  onDecline(userId: string): void;
}) {
  const { locale, t } = useTranslation();

  if (loadFailed) {
    return (
      <p className="text-sm text-destructive">{t("collaborationWorkspaceRequestsLoadFailed")}</p>
    );
  }
  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">{t("collaborationWorkspaceRequestsLoading")}</p>
    );
  }
  if (accessRequests.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
        {t("collaborationWorkspaceRequestsEmpty")}
      </p>
    );
  }

  return (
    <ul className="grid gap-2">
      {accessRequests.map((accessRequest) => (
        <li
          key={accessRequest.userId}
          data-testid="collaboration-workspace-request-row"
          className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md border p-3"
        >
          <span className="grid min-w-0 gap-0.5">
            <span className="truncate text-sm font-medium">{accessRequest.displayLabel}</span>
            <span className="truncate text-xs text-muted-foreground">
              {accessRequest.email ?? ""}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {t("collaborationWorkspaceRequestedOn", {
                date: formatRequestDate(accessRequest.createdAt, locale)
              })}
            </span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onDecline(accessRequest.userId)}
          >
            {t("collaborationWorkspaceDecline")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => onApprove(accessRequest.userId)}
          >
            {t("collaborationWorkspaceApprove")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Owners manage everyone. Admins may not grant admin or owner, which leaves no
 * role they could actually assign, so the select stays owner-only.
 */
export function canChangeCollaborationWorkspaceRole(actorRole: WorkspaceMembershipRole): boolean {
  return actorRole === "owner";
}

export function canRemoveCollaborationWorkspaceMember(
  actorRole: WorkspaceMembershipRole,
  targetRole: WorkspaceMembershipRole
): boolean {
  if (actorRole === "owner") {
    return true;
  }
  return actorRole === "admin" && targetRole === "member";
}

function formatRequestDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
