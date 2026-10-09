import { LogOut, Trash2, UserPlus } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  CollaborationWorkspaceWithRole,
  WorkspaceAccessRequestItem,
  WorkspaceMember,
  WorkspaceMemberCandidate,
  WorkspaceMembershipRole
} from "@vivd-catalyst/api-client";
import {
  Badge,
  Button,
  cn,
  Dialog,
  Input,
  Select,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useScrollEdgeFade
} from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../i18n";
import {
  resolveCollaborationWorkspaceAccentColor,
  type CollaborationWorkspaceAccentColor
} from "./collaboration-workspace-accent";
import {
  CollaborationWorkspaceAvatar,
  collaborationWorkspaceInitials
} from "./collaboration-workspace-avatar";
import {
  CollaborationWorkspaceDialogFooter,
  CollaborationWorkspaceDialogScrollBody
} from "./collaboration-workspace-dialog-chrome";
import {
  CollaborationWorkspaceAccentField,
  CollaborationWorkspaceConversationVisibilityField,
  CollaborationWorkspaceEmojiField,
  CollaborationWorkspaceVisibilityField,
  type CollaborationWorkspaceVisibility,
  type ConversationVisibility
} from "./collaboration-workspace-fields";

export interface CollaborationWorkspaceSettingsValues {
  name: string;
  description: string | null;
  visibility: CollaborationWorkspaceVisibility;
  defaultConversationVisibility: ConversationVisibility;
  emoji: string | null;
  accentColor: CollaborationWorkspaceAccentColor;
}

export type CollaborationWorkspaceSettingsTab = "general" | "members" | "requests";

/** The appearance fields the header avatar previews while they are unsaved. */
export interface CollaborationWorkspaceAppearance {
  emoji: string | null;
  accentColor: CollaborationWorkspaceAccentColor;
}

const settingsTabs: Array<{ id: CollaborationWorkspaceSettingsTab; label: TranslationKey }> = [
  { id: "general", label: "collaborationWorkspaceTabGeneral" },
  { id: "members", label: "collaborationWorkspaceTabMembers" },
  { id: "requests", label: "collaborationWorkspaceTabRequests" }
];

/** Every tab's panel has this one height, so the dialog's frame does not jump between tabs. */
const settingsTabPanelClassName = "h-[clamp(20rem,68vh,44rem)] overflow-hidden";

/** One settings dialog is on screen at a time, so fixed ids are enough here. */
const collaborationWorkspaceMemberCandidateListId = "collaboration-workspace-member-candidates";

function collaborationWorkspaceMemberCandidateOptionId(index: number): string {
  return `${collaborationWorkspaceMemberCandidateListId}-${index}`;
}

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
  memberCandidates,
  memberCandidatesLoading,
  accessRequests,
  accessRequestsLoading,
  accessRequestsLoadFailed,
  savePending,
  membershipPending,
  errorMessage,
  onClose,
  onSave,
  onMemberCandidateSearchChange,
  onAddMember,
  onChangeMemberRole,
  onRemoveMember,
  onLeave,
  onRequestDelete,
  onApproveAccessRequest,
  onDeclineAccessRequest
}: {
  open: boolean;
  collaborationWorkspace: CollaborationWorkspaceWithRole;
  currentUserId: string | undefined;
  members: WorkspaceMember[];
  membersLoading: boolean;
  membersLoadFailed: boolean;
  memberCandidates: WorkspaceMemberCandidate[];
  memberCandidatesLoading: boolean;
  accessRequests: WorkspaceAccessRequestItem[];
  accessRequestsLoading: boolean;
  accessRequestsLoadFailed: boolean;
  savePending: boolean;
  membershipPending: boolean;
  errorMessage: string | undefined;
  onClose(): void;
  onSave(values: CollaborationWorkspaceSettingsValues): void;
  /** Raw search term; the caller debounces it and owns the candidates query. */
  onMemberCandidateSearchChange(query: string): void;
  onAddMember(email: string): void;
  onChangeMemberRole(userId: string, role: WorkspaceMembershipRole): void;
  onRemoveMember(userId: string): void;
  onLeave(): void;
  onRequestDelete(): void;
  onApproveAccessRequest(userId: string): void;
  onDeclineAccessRequest(userId: string): void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CollaborationWorkspaceSettingsTab>("general");
  /*
   * The header avatar is the preview for the General tab's appearance fields,
   * so it follows the unsaved draft rather than the stored workspace. The draft
   * lives here because the avatar sits above the tabs, outside the tab that
   * owns the form. Undefined means "nothing edited yet", which is also the
   * state it returns to when the dialog closes without saving.
   */
  const [draft, setDraft] = useState<CollaborationWorkspaceAppearance | undefined>();

  useEffect(() => {
    if (!open) {
      setTab("general");
      setDraft(undefined);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      title={t("collaborationWorkspaceSettingsTitle")}
      className="chat-scrollbar w-[min(44rem,calc(100vw-2rem))]"
      onClose={onClose}
    >
      {/*
        Full-bleed: the dialog body's own p-5 is cancelled so the tab bar rule,
        the scrolling panel and the pinned footer can each reach the dialog edge
        and own their padding. Everything above the tabpanel stays put; only the
        active tab's content scrolls.
      */}
      <Tabs
        className="-m-5 grid"
        value={tab}
        onValueChange={(value) => {
          const selected = settingsTabs.find((candidate) => candidate.id === value);
          if (selected) {
            setTab(selected.id);
          }
        }}
      >
        <div className="grid gap-5 px-5 pt-5">
          <CollaborationWorkspaceSettingsHeader
            name={collaborationWorkspace.name}
            membershipRole={collaborationWorkspace.membershipRole}
            appearance={
              draft ?? {
                emoji: collaborationWorkspace.emoji,
                accentColor: resolveCollaborationWorkspaceAccentColor(collaborationWorkspace)
              }
            }
          />

          {/*
            The rule under the tabs is the top edge of the scrolling panel, so
            content scrolling away passes under a real boundary instead of being
            cut off in open space.
          */}
          <TabsList label={t("collaborationWorkspaceSettingsTitle")}>
            {settingsTabs.map((candidate) => (
              <TabsTrigger key={candidate.id} value={candidate.id}>
                {candidate.id === "requests"
                  ? t(candidate.label, { count: accessRequests.length })
                  : t(candidate.label)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {errorMessage ? (
          <p className="border-b px-5 py-3 text-sm text-destructive">{errorMessage}</p>
        ) : null}

        {/*
          One height for every tab so the dialog frame never jumps while
          switching. The clamp keeps it inside short viewports: with the body
          padding now owned by the panel, the surrounding chrome (dialog header,
          identity row, tabs) runs to roughly 11rem, so 68vh still leaves
          headroom under the native dialog max-height on a 13" laptop.

          The panel itself does not scroll. Each tab splits this fixed height
          into its own scrolling region and, where it has one, a pinned action
          footer, so a save button is never scrolled out of reach.
        */}
        <TabsContent value="general" className={settingsTabPanelClassName}>
          <CollaborationWorkspaceGeneralTab
            collaborationWorkspace={collaborationWorkspace}
            currentUserId={currentUserId}
            members={members}
            savePending={savePending}
            membershipPending={membershipPending}
            onSave={onSave}
            onLeave={onLeave}
            onRequestDelete={onRequestDelete}
            onAppearanceDraftChange={setDraft}
          />
        </TabsContent>
        <TabsContent value="members" className={settingsTabPanelClassName}>
          <CollaborationWorkspaceMembersTab
            collaborationWorkspace={collaborationWorkspace}
            currentUserId={currentUserId}
            members={members}
            loading={membersLoading}
            loadFailed={membersLoadFailed}
            memberCandidates={memberCandidates}
            memberCandidatesLoading={memberCandidatesLoading}
            pending={membershipPending}
            onMemberCandidateSearchChange={onMemberCandidateSearchChange}
            onAddMember={onAddMember}
            onChangeMemberRole={onChangeMemberRole}
            onRemoveMember={onRemoveMember}
          />
        </TabsContent>
        <TabsContent value="requests" className={settingsTabPanelClassName}>
          <CollaborationWorkspaceRequestsTab
            accessRequests={accessRequests}
            loading={accessRequestsLoading}
            loadFailed={accessRequestsLoadFailed}
            pending={membershipPending}
            onApprove={onApproveAccessRequest}
            onDecline={onDeclineAccessRequest}
          />
        </TabsContent>
      </Tabs>
    </Dialog>
  );
}

/**
 * The identity block pinned above the tabs. `appearance` is a parameter rather
 * than something read off `collaborationWorkspace` because this tile doubles as
 * the live preview for the General tab's emoji and color fields: picking either
 * one has to show up here before anything is saved.
 */
export function CollaborationWorkspaceSettingsHeader({
  name,
  membershipRole,
  appearance
}: {
  name: string;
  /** Null for a superadmin who manages the workspace without being a member. */
  membershipRole: WorkspaceMembershipRole | null;
  appearance: CollaborationWorkspaceAppearance;
}) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <CollaborationWorkspaceAvatar
        name={name}
        emoji={appearance.emoji}
        accentColor={appearance.accentColor}
        size="lg"
      />
      <div className="grid min-w-0 gap-1">
        <strong className="truncate text-sm font-semibold">{name}</strong>
        <span className="text-xs text-muted-foreground">
          {t(
            membershipRole
              ? roleLabelKeys[membershipRole]
              : "collaborationWorkspaceRoleSuperadminOnly"
          )}
        </span>
      </div>
    </div>
  );
}

export function CollaborationWorkspaceGeneralTab({
  collaborationWorkspace,
  currentUserId,
  members,
  savePending,
  membershipPending,
  onSave,
  onLeave,
  onRequestDelete,
  onAppearanceDraftChange
}: {
  collaborationWorkspace: CollaborationWorkspaceWithRole;
  currentUserId: string | undefined;
  members: WorkspaceMember[];
  savePending: boolean;
  membershipPending: boolean;
  onSave(values: CollaborationWorkspaceSettingsValues): void;
  onLeave(): void;
  onRequestDelete(): void;
  /**
   * Reports the unsaved emoji and accent so the dialog header can preview them.
   * Must be referentially stable, since it is an effect dependency.
   */
  onAppearanceDraftChange?(draft: CollaborationWorkspaceAppearance): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(collaborationWorkspace.name);
  const [description, setDescription] = useState(collaborationWorkspace.description ?? "");
  const [emoji, setEmoji] = useState(collaborationWorkspace.emoji ?? "");
  const [visibility, setVisibility] = useState<CollaborationWorkspaceVisibility>(
    collaborationWorkspace.visibility
  );
  const [defaultConversationVisibility, setDefaultConversationVisibility] =
    useState<ConversationVisibility>(collaborationWorkspace.defaultConversationVisibility);
  const [accentColor, setAccentColor] = useState<CollaborationWorkspaceAccentColor>(
    resolveCollaborationWorkspaceAccentColor(collaborationWorkspace)
  );
  const [confirmLeaveOpen, setConfirmLeaveOpen] = useState(false);
  const trimmedName = name.trim();
  const otherOwnerExists = members.some(
    (member) => member.role === "owner" && member.userId !== currentUserId
  );
  const isMember = collaborationWorkspace.membershipRole !== null;
  const canLeave = collaborationWorkspace.membershipRole !== "owner" || otherOwnerExists;
  const canDelete = canDeleteCollaborationWorkspace(collaborationWorkspace);

  useEffect(() => {
    setName(collaborationWorkspace.name);
    setDescription(collaborationWorkspace.description ?? "");
    setEmoji(collaborationWorkspace.emoji ?? "");
    setVisibility(collaborationWorkspace.visibility);
    setDefaultConversationVisibility(collaborationWorkspace.defaultConversationVisibility);
    setAccentColor(resolveCollaborationWorkspaceAccentColor(collaborationWorkspace));
  }, [collaborationWorkspace]);

  /*
   * Push the appearance draft up on every change so the header avatar previews
   * it. Reporting the resolved accent rather than the stored one also means the
   * header stops showing a stale colour for a workspace whose accent was only
   * ever derived from its name.
   */
  useEffect(() => {
    onAppearanceDraftChange?.({ emoji, accentColor });
  }, [emoji, accentColor, onAppearanceDraftChange]);

  return (
    <>
      {/*
        The tab owns the split of the panel's fixed height: the fields scroll,
        the save action does not. Leaving and deleting stay inside the scrolling
        region, below the form, because they are secondary to saving.
      */}
      <form
        className="grid h-full grid-rows-[minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmedName || savePending) {
            return;
          }
          onSave({
            name: trimmedName,
            description: description.trim() ? description.trim() : null,
            visibility,
            defaultConversationVisibility,
            emoji: emoji.trim() ? emoji.trim() : null,
            accentColor
          });
        }}
      >
        <CollaborationWorkspaceDialogScrollBody>
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
          {collaborationWorkspace.kind === "shared" ? (
            <CollaborationWorkspaceConversationVisibilityField
              value={defaultConversationVisibility}
              disabled={savePending}
              onChange={setDefaultConversationVisibility}
            />
          ) : null}
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

          <div className="grid gap-2 border-t pt-5">
            {/* A superadmin without a membership has nothing to leave. */}
            {isMember ? (
              <>
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
              </>
            ) : null}
            {canDelete ? (
              <Button
                type="button"
                variant="ghost"
                className="h-9 w-fit justify-start text-destructive hover:bg-destructive/10"
                data-testid="collaboration-workspace-delete-trigger"
                disabled={membershipPending}
                onClick={onRequestDelete}
              >
                <Trash2 size={16} aria-hidden="true" />
                <span>{t("collaborationWorkspaceDelete")}</span>
              </Button>
            ) : null}
          </div>
        </CollaborationWorkspaceDialogScrollBody>

        <CollaborationWorkspaceDialogFooter>
          <Button type="submit" disabled={savePending || !trimmedName}>
            {savePending ? t("saving") : t("configSaveChanges")}
          </Button>
        </CollaborationWorkspaceDialogFooter>
      </form>

      {isMember ? (
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
      ) : null}
    </>
  );
}

export function CollaborationWorkspaceMembersTab({
  collaborationWorkspace,
  currentUserId,
  members,
  loading,
  loadFailed,
  memberCandidates,
  memberCandidatesLoading,
  pending,
  onMemberCandidateSearchChange,
  onAddMember,
  onChangeMemberRole,
  onRemoveMember
}: {
  collaborationWorkspace: CollaborationWorkspaceWithRole;
  currentUserId: string | undefined;
  members: WorkspaceMember[];
  loading: boolean;
  loadFailed: boolean;
  memberCandidates: WorkspaceMemberCandidate[];
  memberCandidatesLoading: boolean;
  pending: boolean;
  onMemberCandidateSearchChange(query: string): void;
  onAddMember(email: string): void;
  onChangeMemberRole(userId: string, role: WorkspaceMembershipRole): void;
  onRemoveMember(userId: string): void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [memberCandidatesOpen, setMemberCandidatesOpen] = useState(false);
  const [highlightedMemberCandidate, setHighlightedMemberCandidate] = useState(-1);
  const [memberPendingRemoval, setMemberPendingRemoval] = useState<WorkspaceMember | undefined>();
  const comboboxRef = useRef<HTMLDivElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const actorRole = collaborationWorkspace.role;
  // Empty results stay quiet: no dropdown, no "nothing found" copy.
  const memberCandidateListOpen = memberCandidatesOpen && memberCandidates.length > 0;
  const highlightedCandidate = memberCandidateListOpen
    ? memberCandidates[highlightedMemberCandidate]
    : undefined;

  useEffect(() => {
    setHighlightedMemberCandidate(-1);
  }, [memberCandidates]);

  useEffect(() => {
    if (!memberCandidateListOpen) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (!comboboxRef.current?.contains(event.target as Node)) {
        setMemberCandidatesOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [memberCandidateListOpen]);

  /** Selecting only fills the field; the add flow stays untouched. */
  function selectMemberCandidate(candidate: WorkspaceMemberCandidate) {
    setEmail(candidate.email);
    setMemberCandidatesOpen(false);
    setHighlightedMemberCandidate(-1);
    emailInputRef.current?.focus();
  }

  function closeMemberCandidates() {
    setMemberCandidatesOpen(false);
    setHighlightedMemberCandidate(-1);
  }

  function onEmailKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (memberCandidates.length === 0) {
        return;
      }
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setMemberCandidatesOpen(true);
      setHighlightedMemberCandidate((current) =>
        nextCollaborationWorkspaceMemberCandidate(
          memberCandidatesOpen ? current : -1,
          offset,
          memberCandidates.length
        )
      );
      return;
    }
    if (event.key === "Enter" && highlightedCandidate) {
      event.preventDefault();
      selectMemberCandidate(highlightedCandidate);
      return;
    }
    if (event.key === "Escape" && memberCandidateListOpen) {
      /*
       * The settings dialog is a native <dialog>, so an unhandled Escape would
       * close the whole dialog instead of just the suggestion list.
       */
      event.preventDefault();
      event.stopPropagation();
      closeMemberCandidates();
      return;
    }
    if (event.key === "Tab") {
      closeMemberCandidates();
    }
  }

  return (
    <>
      <CollaborationWorkspaceDialogScrollBody className="h-full">
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
            closeMemberCandidates();
            onMemberCandidateSearchChange("");
          }}
        >
          <label className="text-sm font-medium" htmlFor="collaboration-workspace-member-email">
            {t("collaborationWorkspaceAddMemberLabel")}
          </label>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <div ref={comboboxRef} className="relative min-w-0">
              <Input
                ref={emailInputRef}
                id="collaboration-workspace-member-email"
                type="email"
                /*
                 * A workspace admin adds other people here, so the browser's own
                 * address autofill would only offer the operator's private
                 * addresses. The neutral name keeps heuristic autofill off too.
                 */
                name="collaboration-workspace-member-email"
                autoComplete="off"
                className="pr-9"
                role="combobox"
                aria-expanded={memberCandidateListOpen}
                aria-controls={collaborationWorkspaceMemberCandidateListId}
                aria-autocomplete="list"
                aria-activedescendant={
                  highlightedCandidate
                    ? collaborationWorkspaceMemberCandidateOptionId(highlightedMemberCandidate)
                    : undefined
                }
                value={email}
                disabled={pending}
                placeholder={t("collaborationWorkspaceAddMemberPlaceholder")}
                onChange={(event) => {
                  const nextEmail = event.currentTarget.value;
                  setEmail(nextEmail);
                  setMemberCandidatesOpen(true);
                  setHighlightedMemberCandidate(-1);
                  onMemberCandidateSearchChange(nextEmail.trim());
                }}
                onFocus={() => {
                  setMemberCandidatesOpen(true);
                  onMemberCandidateSearchChange(email.trim());
                }}
                onBlur={() => {
                  // The suggestions only load while the field has focus.
                  closeMemberCandidates();
                  onMemberCandidateSearchChange("");
                }}
                onKeyDown={onEmailKeyDown}
              />
              {memberCandidatesLoading ? (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  <Spinner size="sm" />
                  <span className="sr-only">
                    {t("collaborationWorkspaceMemberCandidatesLoading")}
                  </span>
                </span>
              ) : null}
              {memberCandidateListOpen ? (
                <CollaborationWorkspaceMemberCandidateList
                  candidates={memberCandidates}
                  highlightedIndex={highlightedMemberCandidate}
                  onSelect={selectMemberCandidate}
                />
              ) : null}
            </div>
            <Button type="submit" variant="outline" disabled={pending}>
              <UserPlus size={16} aria-hidden="true" />
              {t("collaborationWorkspaceAddMemberSubmit")}
            </Button>
          </div>
        </form>

        {loadFailed ? (
          <p className="text-sm text-destructive">{t("collaborationWorkspaceMembersLoadFailed")}</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">
            {t("collaborationWorkspaceMembersLoading")}
          </p>
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
                    <Badge>{t(roleLabelKeys[member.role])}</Badge>
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
      </CollaborationWorkspaceDialogScrollBody>

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
    </>
  );
}

/**
 * Suggestion popover for the add-member field, styled like the workspace
 * selector menu. Options are not focusable: focus stays in the input and
 * `aria-activedescendant` carries the highlight, per the combobox pattern.
 */
export function CollaborationWorkspaceMemberCandidateList({
  candidates,
  highlightedIndex,
  onSelect
}: {
  candidates: WorkspaceMemberCandidate[];
  highlightedIndex: number;
  onSelect(candidate: WorkspaceMemberCandidate): void;
}) {
  const { t } = useTranslation();
  const fade = useScrollEdgeFade<HTMLUListElement>([candidates.length]);

  return (
    /*
      As in the emoji grid: the frame owns the rounded border and the list
      scrolls inside its padding, so the thumb stays clear of the corner radius,
      and the edge fade says whether more suggestions are hidden.
    */
    <div className="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
      <ul
        ref={fade.ref}
        style={fade.style}
        role="listbox"
        id={collaborationWorkspaceMemberCandidateListId}
        aria-label={t("collaborationWorkspaceMemberCandidatesLabel")}
        className="chat-scrollbar grid max-h-56 auto-rows-max gap-0.5 overflow-y-auto"
        onScroll={fade.onScroll}
      >
        {candidates.map((candidate, index) => (
          <li
            key={candidate.userId}
            role="option"
            id={collaborationWorkspaceMemberCandidateOptionId(index)}
            aria-selected={index === highlightedIndex}
            data-testid="collaboration-workspace-member-candidate"
            className={cn(
              "grid min-w-0 cursor-pointer gap-0.5 rounded-md px-2 py-1.5",
              index === highlightedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
            )}
            // Keeps the click from pulling focus out of the input.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(candidate)}
          >
            <span className="truncate text-sm font-medium">{candidate.displayLabel}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">{candidate.email}</span>
              {candidate.hasPendingAccessRequest ? (
                <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[0.6875rem] text-secondary-foreground">
                  {t("collaborationWorkspaceMemberCandidatePendingRequest")}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Arrow keys wrap around, and start at either end when nothing is highlighted. */
export function nextCollaborationWorkspaceMemberCandidate(
  currentIndex: number,
  offset: number,
  count: number
): number {
  if (count === 0) {
    return -1;
  }
  const from = currentIndex < 0 ? (offset > 0 ? -1 : 0) : currentIndex;
  return (from + offset + count) % count;
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

  /*
    Every state goes through the same scrolling region so the tab keeps one
    padding rhythm, whether it shows a list, a message or an empty state.
  */
  if (loadFailed) {
    return (
      <CollaborationWorkspaceDialogScrollBody className="h-full">
        <p className="text-sm text-destructive">{t("collaborationWorkspaceRequestsLoadFailed")}</p>
      </CollaborationWorkspaceDialogScrollBody>
    );
  }
  if (loading) {
    return (
      <CollaborationWorkspaceDialogScrollBody className="h-full">
        <p className="text-sm text-muted-foreground">
          {t("collaborationWorkspaceRequestsLoading")}
        </p>
      </CollaborationWorkspaceDialogScrollBody>
    );
  }
  if (accessRequests.length === 0) {
    return (
      <CollaborationWorkspaceDialogScrollBody className="h-full">
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {t("collaborationWorkspaceRequestsEmpty")}
        </p>
      </CollaborationWorkspaceDialogScrollBody>
    );
  }

  return (
    <CollaborationWorkspaceDialogScrollBody className="h-full">
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
    </CollaborationWorkspaceDialogScrollBody>
  );
}

/**
 * Owners manage everyone. Admins may not grant admin or owner, which leaves no
 * role they could actually assign, so the select stays owner-only.
 */
export function canChangeCollaborationWorkspaceRole(actorRole: WorkspaceMembershipRole): boolean {
  return actorRole === "owner";
}

/** Only an owner deletes, and the Personal Workspace is never deletable. */
export function canDeleteCollaborationWorkspace(
  collaborationWorkspace: Pick<CollaborationWorkspaceWithRole, "kind" | "role">
): boolean {
  return collaborationWorkspace.kind === "shared" && collaborationWorkspace.role === "owner";
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
