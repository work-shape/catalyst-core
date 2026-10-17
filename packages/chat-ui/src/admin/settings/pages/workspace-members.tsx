// @rights-screen: included in the rights wording guard.
import type {
  CollaborationWorkspaceWithRole,
  LocaleCode,
  WorkspaceAccessRequestItem,
  WorkspaceMember,
  WorkspaceMemberCandidate,
  WorkspaceMembershipRole
} from "@work-shape/catalyst-api-client";
import { WORKSPACE_MEMBERSHIP_ROLES } from "@work-shape/catalyst-core";
import {
  Avatar,
  Banner,
  Button,
  ConfirmDialog,
  IconButton,
  List,
  ListRow,
  PageHeader,
  Section,
  Select,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useCollaborationWorkspaceMutations } from "../../../shared/api/collaboration-workspace-mutations";
import {
  useCollaborationWorkspaceAccessRequestsQuery,
  useCollaborationWorkspaceMemberCandidatesQuery,
  useCollaborationWorkspaceMembersQuery
} from "../../../shared/api/workspace-queries";
import {
  collaborationWorkspaceErrorKey,
  type CollaborationWorkspaceAction
} from "../../../shared/collaboration-workspace/collaboration-workspace-errors";
import { CollaborationWorkspaceAddMemberForm } from "../../../shared/collaboration-workspace/collaboration-workspace-member-search";
import {
  canChangeCollaborationWorkspaceRole,
  canRemoveCollaborationWorkspaceMember,
  collaborationWorkspaceRoleLabelKeys
} from "../../../shared/collaboration-workspace/collaboration-workspace-roles";
import { useTranslation, type TranslationKey } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";
import { isRefusal, refusalAskingInstanceAdmin } from "../ask-instance-admin";

/** The server answers a candidate search from this many characters on; below it nothing is asked. */
const MEMBER_CANDIDATE_MIN_QUERY_CHARS = 2;
/** How long typing rests before the candidate search is asked, so not every keystroke asks. */
const MEMBER_CANDIDATE_DEBOUNCE_MS = 250;
const noMemberCandidates: WorkspaceMemberCandidate[] = [];
const memberRoles: readonly WorkspaceMembershipRole[] = [...WORKSPACE_MEMBERSHIP_ROLES];

/** What this page changes, and the section whose top says when it fails. */
type MembersAction = Extract<
  CollaborationWorkspaceAction,
  "addMember" | "changeRole" | "removeMember" | "approveRequest" | "declineRequest"
>;
type MembersSection = "members" | "requests";

/** A refusal names the action it refused, in the section the action stands in. */
const membersActions: Record<MembersAction, { refused: TranslationKey; section: MembersSection }> =
  {
    addMember: { refused: "collaborationWorkspaceRefusedAddMember", section: "members" },
    changeRole: { refused: "collaborationWorkspaceRefusedChangeRole", section: "members" },
    removeMember: { refused: "collaborationWorkspaceRefusedRemoveMember", section: "members" },
    approveRequest: {
      refused: "collaborationWorkspaceRefusedApproveRequest",
      section: "requests"
    },
    declineRequest: {
      refused: "collaborationWorkspaceRefusedDeclineRequest",
      section: "requests"
    }
  };

/**
 * Workspace > Members: who belongs to the shared workspace, and below them who asked to join,
 * while anybody does. The rail's switcher says which workspace this is.
 */
export function WorkspaceMembersPage() {
  const { t } = useTranslation();
  const { workspace } = useSettingsPage();

  // Keyed by the workspace, so a switch in the rail starts from closed forms.
  return workspace ? (
    <WorkspaceMembers key={workspace.id} workspace={workspace} />
  ) : (
    <PageHeader title={t("settings.members")} />
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
  const { t } = useTranslation();
  // The action and its key, not the message: the message follows the language, and a refusal
  // names the action and which instance admin to ask.
  const [failed, setFailed] = useState<{ action: MembersAction; errorKey: TranslationKey }>();
  const clearError = () => setFailed(undefined);
  const reportError = (action: MembersAction, error: unknown) =>
    setFailed({ action, errorKey: collaborationWorkspaceErrorKey(action, error) });
  const actionProblem: ActionProblem | undefined = failed && {
    section: membersActions[failed.action].section,
    ...(failed.errorKey === "collaborationWorkspaceErrorNotPermitted"
      ? {
          message: refusalAskingInstanceAdmin(
            t(membersActions[failed.action].refused),
            t,
            user.instanceAdminName
          ),
          refused: true
        }
      : { message: t(failed.errorKey), refused: false })
  };
  // A refusal says whom to ask and offers no retry, which would not help; a failure offers one.
  const loadProblem = (
    error: unknown,
    refused: TranslationKey,
    failure: TranslationKey,
    retry: () => void
  ): Problem | undefined =>
    !error
      ? undefined
      : isRefusal(error)
        ? {
            message: refusalAskingInstanceAdmin(t(refused), t, user.instanceAdminName),
            refused: true
          }
        : { message: t(failure), refused: false, retry };

  return (
    <WorkspaceMembersView
      workspace={workspace}
      currentUserId={user.id}
      members={membersQuery.data}
      membersLoadProblem={loadProblem(
        membersQuery.error,
        "collaborationWorkspaceMembersLoadRefused",
        "collaborationWorkspaceMembersLoadFailed",
        () => void membersQuery.refetch().catch(() => undefined)
      )}
      accessRequests={accessRequestsQuery.data}
      accessRequestsLoadProblem={loadProblem(
        accessRequestsQuery.error,
        "collaborationWorkspaceRequestsLoadRefused",
        "collaborationWorkspaceRequestsLoadFailed",
        () => void accessRequestsQuery.refetch().catch(() => undefined)
      )}
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
      actionProblem={actionProblem}
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

/**
 * The page head with Add member, the members, then the requests to join while there are any,
 * without the data behind them.
 */
export function WorkspaceMembersView({
  workspace,
  currentUserId,
  members,
  membersLoadProblem,
  accessRequests,
  accessRequestsLoadProblem,
  memberCandidates,
  memberCandidatesLoading,
  pending,
  actionProblem,
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
  membersLoadProblem: Problem | undefined;
  /** Absent while the requests load. */
  accessRequests: WorkspaceAccessRequestItem[] | undefined;
  accessRequestsLoadProblem: Problem | undefined;
  memberCandidates: WorkspaceMemberCandidate[];
  memberCandidatesLoading: boolean;
  /** A change to the members or the requests is under way. */
  pending: boolean;
  /** Why the last change failed, said at the top of the section it was made in. */
  actionProblem: ActionProblem | undefined;
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
  const isRemovable = (member: WorkspaceMember) =>
    member.userId !== currentUserId &&
    canRemoveCollaborationWorkspaceMember(actorRole, member.role);
  const anyRemovable = members?.some(isRemovable) ?? false;
  const requestsShown =
    accessRequestsLoadProblem !== undefined || (accessRequests?.length ?? 0) > 0;
  // A change to a request that is gone from the list is said above the members instead.
  const problemIn = (section: MembersSection) =>
    actionProblem &&
    (actionProblem.section === section || (section === "members" && !requestsShown)) ? (
      <ProblemBanner problem={actionProblem} />
    ) : null;

  return (
    <>
      <PageHeader
        title={t("settings.members")}
        description={t("collaborationWorkspaceMembersDescription")}
        primaryAction={
          <Button
            aria-expanded={addOpen}
            onClick={() => {
              setAddOpen((open) => !open);
              onMemberCandidateSearchChange("");
            }}
          >
            <UserPlus aria-hidden="true" />
            {t("settings.addMember")}
          </Button>
        }
      />
      <section
        aria-label={t("settings.members")}
        data-testid="collaboration-workspace-members"
        className="grid min-w-0 gap-4"
      >
        {problemIn("members")}
        {addOpen ? (
          <CollaborationWorkspaceAddMemberForm
            memberCandidates={memberCandidates}
            memberCandidatesLoading={memberCandidatesLoading}
            pending={pending}
            onMemberCandidateSearchChange={onMemberCandidateSearchChange}
            onAddMember={onAddMember}
          />
        ) : null}
        {membersLoadProblem ? (
          <ProblemBanner problem={membersLoadProblem} />
        ) : members === undefined ? (
          <SkeletonList rows={3} />
        ) : (
          <List>
            {members.map((member) => {
              const removable = isRemovable(member);
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
                      ) : anyRemovable ? (
                        // Holds the remove button's place so the role selects stay in one column.
                        <span aria-hidden="true" className="size-8 shrink-0" />
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </List>
        )}
      </section>
      {/* Requests show only while somebody asks, or when they could not be read. */}
      {accessRequestsLoadProblem ? (
        <Section layout="stacked" title={t("settings.requests")}>
          <ProblemBanner problem={accessRequestsLoadProblem} />
        </Section>
      ) : accessRequests && accessRequests.length > 0 ? (
        <Section layout="stacked" title={t("settings.requests")} count={accessRequests.length}>
          {problemIn("requests")}
          <List>
            {accessRequests.map((accessRequest) => (
              <ListRow
                key={accessRequest.userId}
                data-testid="collaboration-workspace-request-row"
                leading={<Avatar kind="person" name={accessRequest.displayLabel} />}
                title={accessRequest.displayLabel}
                // The date after the email, not at the row's end, where it took a phone's room
                // from the name.
                // An email is one long word. `wrap-anywhere` lets it break and lowers the row's
                // narrowest width with it; otherwise it widens the row's column under the actions.
                description={
                  <span className="wrap-anywhere">
                    {[
                      accessRequest.email,
                      t("collaborationWorkspaceRequestedOn", {
                        date: formatRequestDate(accessRequest.createdAt, locale)
                      })
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                }
                descriptionWraps="always"
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
        </Section>
      ) : null}
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

/**
 * Why a list could not be read or a change failed. A refusal is information, since somebody with
 * more rights has to act; a failure is a danger and offers a retry where trying again can help.
 */
interface Problem {
  message: string;
  refused: boolean;
  retry?: () => void;
}

interface ActionProblem extends Problem {
  section: MembersSection;
}

function ProblemBanner({ problem }: { problem: Problem }) {
  const { t } = useTranslation();
  const { retry } = problem;
  return (
    <Banner
      tone={problem.refused ? "info" : "danger"}
      action={
        retry ? (
          <Button size="sm" variant="outline" onClick={retry}>
            {t("tryAgain")}
          </Button>
        ) : undefined
      }
    >
      {problem.message}
    </Banner>
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
