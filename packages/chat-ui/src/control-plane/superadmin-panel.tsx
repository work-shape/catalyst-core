import {
  Activity,
  AlertCircle,
  Bot,
  KeyRound,
  ChevronRight,
  ScrollText,
  Settings2,
  ShieldCheck,
  User as UserIcon,
  Users
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AuditActivity,
  AuditActivityActor,
  AuditActivityTarget,
  AuditEvent
} from "@vivd-catalyst/api-client";
import {
  useApiAccessMutations,
  useConfigAssetMutations,
  useSuperadminUserMutations
} from "../api/workspace-mutations";
import {
  useAdministeredCollaborationWorkspacesQuery,
  useConfigAssetsExportQuery,
  useConfigAssetsOverviewQuery,
  useServicePrincipalsQuery,
  useWorkspaceAuditActivitiesQuery,
  useWorkspaceUsageQuery,
  useWorkspaceUsersQuery
} from "../api/workspace-queries";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import type {
  ChatShellAdminPanelInput,
  ChatShellAdminRouteInput,
  ChatShellAdminRouteState
} from "../chat-shell";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { cn } from "../ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { ConfigAssetsPanel, type ConfigAssetsPanelInput } from "./config-assets-panel";
import { ApiAccessPanel, type ApiAccessPanelInput } from "./api-access-panel";
import { createApiAccessAuthorityKey } from "./api-access-reveal-controller";
import { ControlPlanePage } from "./control-plane-page";
import {
  canEditConfigAssets,
  canManageApiAccess,
  canManageUsers,
  canViewAudit,
  canViewUsageGovernance
} from "./governance";
import { useTranslation } from "../i18n";
import { UsageView } from "./usage-view";
import { UserAdministrationPanel } from "./user-administration-panel";
import type { SuperadminRouteTab } from "../workspace/workspace-route";
import { apiErrorMessage } from "../workspace-utils";

export function SuperadminPanel({
  apiBaseUrl,
  authScope,
  client,
  user,
  configAssetManagement,
  userInvitationsEnabled,
  selectedTab,
  onSelectTab
}: ChatShellAdminPanelInput) {
  const { t } = useTranslation();
  const access = administrationAccess(user, configAssetManagement);
  const showUsage = access.canViewUsageGovernance;
  const manageUsers = access.canManageUsers;
  const manageApiAccess = access.canManageApiAccess;
  const showAudit = access.canViewAudit;
  const editConfigAssets = access.canEditConfigAssets;
  const canManageSuperadminAccess = user.roles.includes("superadmin");
  const usageQuery = useWorkspaceUsageQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: showUsage
  });
  const auditQuery = useWorkspaceAuditActivitiesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: showAudit
  });
  const usersQuery = useWorkspaceUsersQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: manageUsers
  });
  const servicePrincipalsQuery = useServicePrincipalsQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: manageApiAccess
  });
  const userMutations = useSuperadminUserMutations({ apiBaseUrl, authScope, client });
  const apiAccessMutations = useApiAccessMutations({
    apiBaseUrl,
    authScope,
    client,
    authorityKey: createApiAccessAuthorityKey({
      apiBaseUrl,
      principalId: user.id,
      canManageSuperadminAccess
    })
  });
  const configAssetsOverviewQuery = useConfigAssetsOverviewQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: editConfigAssets
  });
  const configAssetsExportQuery = useConfigAssetsExportQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: editConfigAssets
  });
  const administeredWorkspacesQuery = useAdministeredCollaborationWorkspacesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: editConfigAssets
  });
  const configAssetMutations = useConfigAssetMutations({ apiBaseUrl, authScope, client });
  const queryClient = useQueryClient();
  const users = usersQuery.data ?? [];
  const auditActivities = auditQuery.data ?? [];
  const error = usageQuery.error
    ? apiErrorMessage(usageQuery.error, undefined)
    : auditQuery.error
      ? apiErrorMessage(auditQuery.error, undefined)
      : undefined;
  const usersError = usersQuery.error ? apiErrorMessage(usersQuery.error, undefined) : undefined;
  const apiAccess: ApiAccessPanelInput = {
    canMutate: canManageSuperadminAccess,
    principals: servicePrincipalsQuery.data ?? [],
    revealedCredential: apiAccessMutations.revealedCredential,
    loading: servicePrincipalsQuery.isLoading,
    error: servicePrincipalsQuery.error
      ? apiErrorMessage(servicePrincipalsQuery.error, undefined)
      : undefined,
    mutating: apiAccessMutations.isPending,
    onCreatePrincipal: (input) => apiAccessMutations.createPrincipal.mutateAsync(input),
    onUpdatePrincipal: (principalId, update) =>
      apiAccessMutations.updatePrincipal.mutateAsync({ principalId, update }),
    onCreateCredential: (principalId, credential) =>
      apiAccessMutations.createCredential.mutateAsync({ principalId, credential }),
    onRevokeCredential: (credentialId) =>
      apiAccessMutations.revokeCredential.mutateAsync(credentialId),
    onClearRevealedCredential: apiAccessMutations.clearRevealedCredential
  };
  const configAssets: ConfigAssetsPanelInput = {
    editableAgentFields: configAssetManagement?.editableAgentFields ?? [],
    allowAgentCreation: configAssetManagement?.allowAgentCreation ?? false,
    allowAgentDeletion: configAssetManagement?.allowAgentDeletion ?? false,
    allowDefaultAgentChange: configAssetManagement?.allowDefaultAgentChange ?? false,
    allowSkillEditing: configAssetManagement?.allowSkillEditing ?? false,
    overview: configAssetsOverviewQuery.data,
    agents: namedBundleEntries(configAssetsExportQuery.data?.agents),
    skills: namedBundleEntries(configAssetsExportQuery.data?.skills),
    administeredWorkspaces: administeredWorkspacesQuery.data ?? [],
    administeredWorkspacesError: administeredWorkspacesQuery.error
      ? apiErrorMessage(administeredWorkspacesQuery.error, undefined)
      : undefined,
    loading: configAssetsOverviewQuery.isLoading || configAssetsExportQuery.isLoading,
    error:
      configAssetsOverviewQuery.error || configAssetsExportQuery.error
        ? apiErrorMessage(
            configAssetsOverviewQuery.error ?? configAssetsExportQuery.error,
            undefined
          )
        : undefined,
    mutating: configAssetMutations.isPending,
    onSaveAsset: (input) => configAssetMutations.putAsset.mutateAsync(input),
    onDeleteAsset: (input) => configAssetMutations.deleteAsset.mutateAsync(input),
    onSetDefaultAgent: (input) => configAssetMutations.setDefaultAgent.mutateAsync(input),
    onSetAgentAvailability: (input) => configAssetMutations.setAgentAvailability.mutateAsync(input),
    onRevertAsset: (input) => configAssetMutations.revertAsset.mutateAsync(input),
    onLoadRevisions: (kind, name) => client.configAssets.listRevisions(kind, name),
    onReload: () =>
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.configAssetsOverview(apiBaseUrl, authScope)
      })
  };

  useEffect(() => {
    if (!canManageSuperadminAccess) {
      apiAccessMutations.clearRevealedCredential();
    }
  }, [apiAccessMutations.clearRevealedCredential, canManageSuperadminAccess]);

  return (
    <section
      className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background"
      aria-label={t("administrationPanel")}
    >
      <div className="grid gap-3 border-b px-5 pt-20">
        <div className="grid min-w-0 gap-1">
          <span className="text-xs text-muted-foreground">
            {canManageSuperadminAccess ? "Superadmin" : "Admin"}
          </span>
          <h1 className="text-xl font-semibold tracking-normal">{t("administration")}</h1>
        </div>

        <nav
          className="flex items-end gap-1 overflow-x-auto"
          aria-label={t("administrationSections")}
        >
          {manageUsers ? (
            <TabButton
              active={selectedTab === "users"}
              icon={<Users size={15} aria-hidden="true" />}
              label={t("administrationUsers")}
              badge={users.length > 0 ? users.length : undefined}
              onClick={() => onSelectTab("users")}
            />
          ) : null}
          {manageApiAccess ? (
            <TabButton
              active={selectedTab === "api-access"}
              icon={<KeyRound size={15} aria-hidden="true" />}
              label={t("administrationApiAccess")}
              badge={apiAccess.principals.length > 0 ? apiAccess.principals.length : undefined}
              onClick={() => onSelectTab("api-access")}
            />
          ) : null}
          {editConfigAssets ? (
            <TabButton
              active={selectedTab === "config"}
              icon={<Settings2 size={15} aria-hidden="true" />}
              label={t("administrationConfig")}
              onClick={() => onSelectTab("config")}
            />
          ) : null}
          {showUsage ? (
            <TabButton
              active={selectedTab === "usage"}
              icon={<Activity size={15} aria-hidden="true" />}
              label={t("administrationUsage")}
              onClick={() => onSelectTab("usage")}
            />
          ) : null}
          {showAudit ? (
            <TabButton
              active={selectedTab === "audit"}
              icon={<ScrollText size={15} aria-hidden="true" />}
              label={t("administrationAuditLog")}
              onClick={() => onSelectTab("audit")}
            />
          ) : null}
        </nav>
      </div>

      <div className="grid min-h-0 content-start gap-4 overflow-auto bg-background p-5">
        {selectedTab !== "users" && error ? <ErrorBanner message={error} /> : null}

        {selectedTab === "usage" && showUsage ? <UsageView usage={usageQuery.data} /> : null}
        {selectedTab === "users" && manageUsers ? (
          <UserAdministrationPanel
            users={users}
            loading={usersQuery.isLoading}
            error={usersError}
            canManageSuperadminAccess={canManageSuperadminAccess}
            mutating={userMutations.isPending}
            onCreateUser={(input) => userMutations.createUser.mutateAsync(input)}
            onUpdateUser={(userId, update) =>
              userMutations.updateUser.mutateAsync({ userId, update })
            }
            onDeleteUser={(userId) => userMutations.deleteUser.mutateAsync(userId)}
            onUpsertIdentity={(userId, identity) =>
              userMutations.upsertUserIdentity.mutateAsync({ userId, identity })
            }
            onDeleteIdentity={(userId, identity) =>
              userMutations.deleteUserIdentity.mutateAsync({ userId, identity })
            }
            onResetPassword={(userId, password) =>
              userMutations.resetUserPassword.mutateAsync({ userId, password })
            }
            onSendInvitation={
              userInvitationsEnabled
                ? (userId) => userMutations.sendUserInvitation.mutateAsync(userId)
                : undefined
            }
          />
        ) : null}
        {selectedTab === "api-access" && manageApiAccess ? <ApiAccessPanel {...apiAccess} /> : null}
        {selectedTab === "config" && editConfigAssets ? (
          <ConfigAssetsPanel {...configAssets} />
        ) : null}
        {selectedTab === "audit" && showAudit ? (
          <AuditView auditActivities={auditActivities} />
        ) : null}
      </div>
    </section>
  );
}

export function resolveAdministrationRoute(
  input: ChatShellAdminRouteInput
): ChatShellAdminRouteState {
  const access = administrationAccess(input.user, input.configAssetManagement);
  const pending =
    input.requestedTab === "config" &&
    input.configAssetManagement === undefined &&
    canEditConfigAssets(input.user);
  const defaultTab = firstAvailableAdministrationTab(access);
  const selectedTab = pending
    ? "config"
    : input.requestedTab && canViewAdministrationTab(input.requestedTab, access)
      ? input.requestedTab
      : defaultTab;

  return {
    canView: defaultTab !== undefined,
    pending,
    selectedTab
  };
}

interface AdministrationAccess {
  canViewUsageGovernance: boolean;
  canManageUsers: boolean;
  canManageApiAccess: boolean;
  canViewAudit: boolean;
  canEditConfigAssets: boolean;
}

function administrationAccess(
  user: ChatShellAdminRouteInput["user"],
  configAssetManagement: ChatShellAdminRouteInput["configAssetManagement"]
): AdministrationAccess {
  return {
    canViewUsageGovernance: canViewUsageGovernance(user),
    canManageUsers: canManageUsers(user),
    canManageApiAccess: canManageApiAccess(user),
    canViewAudit: canViewAudit(user),
    canEditConfigAssets: configAssetManagement?.enabled === true && canEditConfigAssets(user)
  };
}

function firstAvailableAdministrationTab(
  access: AdministrationAccess
): SuperadminRouteTab | undefined {
  if (access.canManageUsers) return "users";
  if (access.canManageApiAccess) return "api-access";
  if (access.canEditConfigAssets) return "config";
  if (access.canViewUsageGovernance) return "usage";
  if (access.canViewAudit) return "audit";
  return undefined;
}

function canViewAdministrationTab(tab: SuperadminRouteTab, access: AdministrationAccess): boolean {
  if (tab === "usage") return access.canViewUsageGovernance;
  if (tab === "users") return access.canManageUsers;
  if (tab === "api-access") return access.canManageApiAccess;
  if (tab === "config") return access.canEditConfigAssets;
  return access.canViewAudit;
}

function namedBundleEntries(
  configs: Array<Record<string, unknown>> | undefined
): Array<{ name: string; config: Record<string, unknown> }> {
  return (configs ?? []).flatMap((config) => {
    const name = config.name;
    return typeof name === "string" ? [{ name, config }] : [];
  });
}

function TabButton({
  active,
  icon,
  label,
  badge,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  badge?: number;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 rounded-t-md border-b-2 border-transparent px-3 pt-2 pb-2.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active && "border-primary text-foreground"
      )}
      onClick={onClick}
    >
      {icon}
      {label}
      {badge !== undefined ? (
        <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="inline-flex w-fit max-w-[min(42rem,100%)] items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <AlertCircle size={17} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function AuditView({ auditActivities }: { auditActivities: AuditActivity[] }) {
  return (
    <ControlPlanePage
      title="Audit log"
      description={`${auditActivities.length.toLocaleString()} recent ${auditActivities.length === 1 ? "activity" : "activities"}`}
    >
      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Recent activity</CardTitle>
          <p className="text-xs text-muted-foreground">
            Governance and workflow events, plus anything that failed or was denied. Expand a row
            for the underlying evidence.
          </p>
        </CardHeader>
        <CardContent className="p-4 pt-1">
          {auditActivities.length ? (
            <ul className="divide-y">
              {auditActivities.map((activity) => (
                <AuditActivityRow key={activity.correlationId} activity={activity} />
              ))}
            </ul>
          ) : (
            <p className="pt-1 text-sm text-muted-foreground">No activity visible yet.</p>
          )}
        </CardContent>
      </Card>
    </ControlPlanePage>
  );
}

function AuditActivityRow({ activity }: { activity: AuditActivity }) {
  const [open, setOpen] = useState(false);
  const showReason = Boolean(activity.reason) && activity.outcome !== "success";

  return (
    <li className="py-2 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 rounded-md px-1 py-1 text-left hover:bg-muted/40"
      >
        <ChevronRight
          size={16}
          aria-hidden="true"
          className={cn(
            "mt-0.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{activity.label}</span>
            <OutcomeBadge outcome={activity.outcome} />
            {activity.repeatCount > 1 ? (
              <span className="text-xs text-muted-foreground">×{activity.repeatCount}</span>
            ) : null}
            {activity.tier === "governance" ? (
              <Badge variant="secondary" className="gap-1">
                <ShieldCheck size={12} aria-hidden="true" />
                Governance
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">{formatDateTime(activity.at)}</span>
            <ActorChip actor={activity.actor} />
            {activity.target ? (
              <span className="break-all">{targetText(activity.target)}</span>
            ) : null}
            <span className="whitespace-nowrap">{formatEventCount(activity.eventCount)}</span>
          </div>
          {showReason ? (
            <p className="text-xs break-words text-destructive">{activity.reason}</p>
          ) : null}
        </div>
      </button>
      {open ? <AuditEvidence evidence={activity.evidence} /> : null}
    </li>
  );
}

function AuditEvidence({ evidence }: { evidence: AuditEvent[] }) {
  return (
    <div className="mt-2 ml-6 overflow-hidden rounded-md border bg-muted/30">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {evidence.map((event) => (
            <TableRow key={event.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {formatDateTime(event.createdAt)}
              </TableCell>
              <TableCell className="font-mono text-xs break-words">{event.type}</TableCell>
              <TableCell>
                <Badge
                  variant={event.status === "success" ? "success" : "outline"}
                  className={cn(
                    "capitalize",
                    event.status !== "success" && "border-destructive/40 text-destructive"
                  )}
                >
                  {event.status}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{evidenceActorText(event)}</TableCell>
              <TableCell className="break-all text-muted-foreground">
                {event.subject ?? "—"}
              </TableCell>
              <TableCell className="break-words text-muted-foreground">
                {evidenceReasonText(event) ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {evidence[0] ? (
        <p className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          correlation: {evidence[0].correlationId}
        </p>
      ) : null}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: AuditActivity["outcome"] }) {
  if (outcome === "success") {
    return <Badge variant="success">Success</Badge>;
  }
  if (outcome === "warning") {
    return (
      <Badge variant="outline" className="border-amber-500 text-amber-600">
        Warning
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-destructive/50 text-destructive capitalize">
      {outcome}
    </Badge>
  );
}

function ActorChip({ actor }: { actor: AuditActivityActor }) {
  const Icon = actor.kind === "assistant" ? Bot : actor.kind === "user" ? UserIcon : ShieldCheck;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon size={12} aria-hidden="true" />
      {actorText(actor)}
    </span>
  );
}

function actorText(actor: AuditActivityActor): string {
  if (actor.kind === "assistant") {
    return actor.onBehalfOf ? `Assistant · for ${actor.onBehalfOf}` : "Assistant";
  }
  if (actor.kind === "service") {
    return `${actor.label} · service`;
  }
  return actor.label;
}

function targetText(target: AuditActivityTarget): string {
  return `${target.kind}: ${target.label ?? target.id}`;
}

function formatEventCount(count: number): string {
  return `${count} event${count === 1 ? "" : "s"}`;
}

function evidenceActorText(event: AuditEvent): string {
  const actor = event.actor;
  if (!actor) {
    return "System";
  }
  if (actor.delegatedActor) {
    return `${actor.delegatedActor.displayLabel ?? "Assistant"} (for ${actor.displayLabel})`;
  }
  return actor.displayLabel;
}

function evidenceReasonText(event: AuditEvent): string | undefined {
  if (event.reason) {
    return event.reason;
  }
  const metadata = event.metadata as Record<string, unknown> | undefined;
  for (const key of ["reason", "code"]) {
    const value = metadata?.[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}
