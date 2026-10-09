import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  CollaborationWorkspaceWithRole,
  LocaleCode,
  WorkspaceAccessRequestItem,
  WorkspaceMember,
  WorkspaceMemberCandidate,
  WorkspaceMembershipRole
} from "@vivd-catalyst/api-client";
import {
  Avatar,
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  List,
  ListRow,
  PageHeader,
  Section,
  Select,
  SkeletonList
} from "@vivd-catalyst/ui";
import { useCollaborationWorkspaceMutations } from "../../api/workspace-mutations";
import {
  useCollaborationWorkspaceAccessRequestsQuery,
  useCollaborationWorkspaceMemberCandidatesQuery,
  useCollaborationWorkspaceMembersQuery
} from "../../api/workspace-queries";
import { useCollaborationWorkspaceActionError } from "../../collaboration-workspace/collaboration-workspace-action-error";
import { CollaborationWorkspaceAddMemberForm } from "../../collaboration-workspace/collaboration-workspace-member-search";
import {
  canChangeCollaborationWorkspaceRole,
  canRemoveCollaborationWorkspaceMember,
  collaborationWorkspaceRoleLabelKeys
} from "../../collaboration-workspace/collaboration-workspace-roles";
import { useTranslation } from "../../i18n";
import { useSettingsPage } from "../settings-page-context";

/** The server answers a candidate search from this many characters on; below it nothing is asked. */
const MEMBER_CANDIDATE_MIN_QUERY_CHARS = 2;
/** How long typing rests before the candidate search is asked, so not every keystroke asks. */
const MEMBER_CANDIDATE_DEBOUNCE_MS = 250;
const noMemberCandidates: WorkspaceMemberCandidate[] = [];
const memberRoles: readonly WorkspaceMembershipRole[] = ["owner", "admin", "member"];

/**
 * Workspace > Members: who asked to join, above who belongs to the shared workspace. The
 * rail's switcher says which workspace this is.
 */
export function WorkspaceMembersPage() {
  const { t } = useTranslation();
  const { workspace } = useSettingsPage();

  return (
    <>
      <PageHeader title={t("settings.members")} />
      {/* Keyed by the workspace, so a switch in the rail starts from closed forms. */}
      {workspace ? <WorkspaceMembers key={workspace.id} workspace={workspace} /> : null}
    </>
  );
}

function WorkspaceMembers({ workspace }: { workspace: CollaborationWorkspaceWithRole }) {
  const { apiBaseUrl, authScope, client, user } = useSettingsPage();
  const collaborationWorkspaceId = workspace.id;
  const [memberCandidateSearch, setMemberCandidateSearch] = useState("");
  const debouncedSearch = useDebouncedValue(memberCandidateSearch, MEMBER_CANDIDATE_DEBOUNCE_MS);
  const membersQuery = useCollaborationWorkspaceMembersQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    enabled: true
  });
  const accessRequestsQuery = useCollaborationWorkspaceAccessRequestsQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    enabled: true
  });
  const memberCandidatesQuery = useCollaborationWorkspaceMemberCandidatesQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    query: debouncedSearch,
    enabled: debouncedSearch.length >= MEMBER_CANDIDATE_MIN_QUERY_CHARS
  });
  const {
    addCollaborationWorkspaceMember,
    changeCollaborationWorkspaceMemberRole,
    removeCollaborationWorkspaceMember,
    approveCollaborationWorkspaceAccessRequest,
    declineCollaborationWorkspaceAccessRequest
  } = useCollaborationWorkspaceMutations({ apiBaseUrl, authScope, client });
  const { errorMessage, clearError, reportError } = useCollaborationWorkspaceActionError();

  return (
    <WorkspaceMembersView
      workspace={workspace}
      currentUserId={user.id}
      members={membersQuery.data}
      membersLoadFailed={Boolean(membersQuery.error)}
      onRetryMembers={() => membersQuery.refetch().catch(() => undefined)}
      accessRequests={accessRequestsQuery.data}
      accessRequestsLoadFailed={Boolean(accessRequestsQuery.error)}
      onRetryAccessRequests={() => accessRequestsQuery.refetch().catch(() => undefined)}
      /* A failed candidate search stays silent: adding reports its own errors. */
      memberCandidates={
        memberCandidatesQuery.error
          ? noMemberCandidates
          : (memberCandidatesQuery.data ?? noMemberCandidates)
      }
      memberCandidatesLoading={memberCandidatesQuery.isFetching}
      pending={
        addCollaborationWorkspaceMember.isPending ||
        changeCollaborationWorkspaceMemberRole.isPending ||
        removeCollaborationWorkspaceMember.isPending ||
        approveCollaborationWorkspaceAccessRequest.isPending ||
        declineCollaborationWorkspaceAccessRequest.isPending
      }
      errorMessage={errorMessage}
      onMemberCandidateSearchChange={setMemberCandidateSearch}
      onAddMember={(email) => {
        clearError();
        addCollaborationWorkspaceMember.mutate(
          { collaborationWorkspaceId, email },
          { onError: (error) => reportError("addMember", error) }
        );
      }}
      onChangeMemberRole={(userId, role) => {
        clearError();
        changeCollaborationWorkspaceMemberRole.mutate(
          { collaborationWorkspaceId, userId, role },
          { onError: (error) => reportError("changeRole", error) }
        );
      }}
      onRemoveMember={(userId) => {
        clearError();
        removeCollaborationWorkspaceMember.mutate(
          { collaborationWorkspaceId, userId },
          { onError: (error) => reportError("removeMember", error) }
        );
      }}
      onApproveAccessRequest={(userId) => {
        clearError();
        approveCollaborationWorkspaceAccessRequest.mutate(
          { collaborationWorkspaceId, userId },
          { onError: (error) => reportError("approveRequest", error) }
        );
      }}
      onDeclineAccessRequest={(userId) => {
        clearError();
        declineCollaborationWorkspaceAccessRequest.mutate(
          { collaborationWorkspaceId, userId },
          { onError: (error) => reportError("declineRequest", error) }
        );
      }}
    />
  );
}

/** The two sections of Members, without the data behind them. */
export function WorkspaceMembersView({
  workspace,
  currentUserId,
  members,
  membersLoadFailed,
  onRetryMembers,
  accessRequests,
  accessRequestsLoadFailed,
  onRetryAccessRequests,
  memberCandidates,
  memberCandidatesLoading,
  pending,
  errorMessage,
  onMemberCandidateSearchChange,
  onAddMember,
  onChangeMemberRole,
  onRemoveMember,
  onApproveAccessRequest,
  onDeclineAccessRequest
}: {
  workspace: CollaborationWorkspaceWithRole;
  currentUserId: string;
  /** Absent while the members load. */
  members: WorkspaceMember[] | undefined;
  membersLoadFailed: boolean;
  onRetryMembers(): void;
  /** Absent while the requests load. */
  accessRequests: WorkspaceAccessRequestItem[] | undefined;
  accessRequestsLoadFailed: boolean;
  onRetryAccessRequests(): void;
  memberCandidates: WorkspaceMemberCandidate[];
  memberCandidatesLoading: boolean;
  /** A change to the members or the requests is under way. */
  pending: boolean;
  errorMessage: string | undefined;
  /** Raw search term; the caller debounces it and owns the candidates query. */
  onMemberCandidateSearchChange(query: string): void;
  onAddMember(email: string): void;
  onChangeMemberRole(userId: string, role: WorkspaceMembershipRole): void;
  onRemoveMember(userId: string): void;
  onApproveAccessRequest(userId: string): void;
  onDeclineAccessRequest(userId: string): void;
}) {
  const { locale, t } = useTranslation();
  const [addOpen, setAddOpen] = useState(false);
  const [memberPendingRemoval, setMemberPendingRemoval] = useState<WorkspaceMember | undefined>();
  const actorRole = workspace.role;
  // Only a workspace people can find gets requests; one that still holds some shows them too.
  const showRequests = workspace.visibility === "discoverable" || (accessRequests?.length ?? 0) > 0;

  return (
    <>
      {errorMessage ? (
        <Banner tone="danger" className="mb-6">
          {errorMessage}
        </Banner>
      ) : null}
      {showRequests ? (
        <Section layout="stacked" title={t("settings.requests")} count={accessRequests?.length}>
          {accessRequestsLoadFailed ? (
            <Banner
              tone="danger"
              action={
                <Button size="sm" variant="outline" onClick={onRetryAccessRequests}>
                  {t("tryAgain")}
                </Button>
              }
            >
              {t("collaborationWorkspaceRequestsLoadFailed")}
            </Banner>
          ) : accessRequests === undefined ? (
            <SkeletonList rows={2} />
          ) : accessRequests.length === 0 ? (
            <EmptyState layout="inline">{t("collaborationWorkspaceRequestsEmpty")}</EmptyState>
          ) : (
            <List>
              {accessRequests.map((accessRequest) => (
                <ListRow
                  key={accessRequest.userId}
                  data-testid="collaboration-workspace-request-row"
                  leading={<Avatar kind="person" name={accessRequest.displayLabel} />}
                  title={accessRequest.displayLabel}
                  description={accessRequest.email ?? undefined}
                  time={t("collaborationWorkspaceRequestedOn", {
                    date: formatRequestDate(accessRequest.createdAt, locale)
                  })}
                  actionsVisible
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => onDeclineAccessRequest(accessRequest.userId)}
                      >
                        {t("collaborationWorkspaceDecline")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => onApproveAccessRequest(accessRequest.userId)}
                      >
                        {t("collaborationWorkspaceApprove")}
                      </Button>
                    </>
                  }
                />
              ))}
            </List>
          )}
        </Section>
      ) : null}
      <Section
        layout="stacked"
        title={t("settings.members")}
        count={members?.length}
        action={
          <Button
            size="sm"
            variant="outline"
            aria-expanded={addOpen}
            onClick={() => {
              setAddOpen((open) => !open);
              onMemberCandidateSearchChange("");
            }}
          >
            {t("settings.addMember")}
          </Button>
        }
      >
        <div className="grid gap-4">
          {addOpen ? (
            <CollaborationWorkspaceAddMemberForm
              memberCandidates={memberCandidates}
              memberCandidatesLoading={memberCandidatesLoading}
              pending={pending}
              onMemberCandidateSearchChange={onMemberCandidateSearchChange}
              onAddMember={onAddMember}
            />
          ) : null}
          {membersLoadFailed ? (
            <Banner
              tone="danger"
              action={
                <Button size="sm" variant="outline" onClick={onRetryMembers}>
                  {t("tryAgain")}
                </Button>
              }
            >
              {t("collaborationWorkspaceMembersLoadFailed")}
            </Banner>
          ) : members === undefined ? (
            <SkeletonList rows={3} />
          ) : (
            <List>
              {members.map((member) => {
                const removable =
                  member.userId !== currentUserId &&
                  canRemoveCollaborationWorkspaceMember(actorRole, member.role);
                return (
                  <ListRow
                    key={member.userId}
                    data-testid="collaboration-workspace-member-row"
                    leading={<Avatar kind="person" name={member.displayLabel} />}
                    title={member.displayLabel}
                    description={member.email ?? undefined}
                    time={
                      canChangeCollaborationWorkspaceRole(actorRole)
                        ? undefined
                        : t(collaborationWorkspaceRoleLabelKeys[member.role])
                    }
                    actionsVisible
                    actions={
                      <>
                        {canChangeCollaborationWorkspaceRole(actorRole) ? (
                          <Select
                            className="w-36"
                            value={member.role}
                            disabled={pending}
                            aria-label={t("collaborationWorkspaceRoleLabel", {
                              name: member.displayLabel
                            })}
                            onChange={(event) => {
                              const role = memberRoles.find(
                                (candidate) => candidate === event.currentTarget.value
                              );
                              if (role) {
                                onChangeMemberRole(member.userId, role);
                              }
                            }}
                          >
                            {memberRoles.map((role) => (
                              <option key={role} value={role}>
                                {t(collaborationWorkspaceRoleLabelKeys[role])}
                              </option>
                            ))}
                          </Select>
                        ) : null}
                        {removable ? (
                          <IconButton
                            label={t("collaborationWorkspaceRemoveMember", {
                              name: member.displayLabel
                            })}
                            disabled={pending}
                            onClick={() => setMemberPendingRemoval(member)}
                          >
                            <Trash2 aria-hidden="true" />
                          </IconButton>
                        ) : null}
                      </>
                    }
                  />
                );
              })}
            </List>
          )}
        </div>
      </Section>
      {memberPendingRemoval ? (
        <ConfirmDialog
          open
          title={t("collaborationWorkspaceRemoveMemberTitle")}
          confirmLabel={t("collaborationWorkspaceRemoveMemberConfirm")}
          loading={pending}
          onConfirm={() => {
            setMemberPendingRemoval(undefined);
            onRemoveMember(memberPendingRemoval.userId);
          }}
          onClose={() => setMemberPendingRemoval(undefined)}
        >
          {t("collaborationWorkspaceRemoveMemberDescription", {
            name: memberPendingRemoval.displayLabel
          })}
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}

function formatRequestDate(value: string, locale: LocaleCode): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}
