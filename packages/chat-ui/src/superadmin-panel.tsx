import {
  Activity,
  AlertCircle,
  Bot,
  ChevronRight,
  ScrollText,
  Settings2,
  ShieldCheck,
  User as UserIcon,
  Users
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  AuditActivity,
  AuditActivityActor,
  AuditActivityTarget,
  AuditEvent,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest,
  UsageSummary
} from "@vivd-catalyst/api-client";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { cn } from "./ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ConfigAssetsPanel, type ConfigAssetsPanelInput } from "./config-assets-panel";
import { ControlPlanePage } from "./control-plane/control-plane-page";
import { useTranslation } from "./i18n";
import { UsageView } from "./usage-view";
import { UserAdministrationPanel } from "./user-administration-panel";
import type { SuperadminRouteTab } from "./workspace-route";

export function SuperadminPanel({
  usage,
  auditActivities,
  users,
  loading,
  usersLoading,
  canViewUsageGovernance,
  canManageUsers,
  canViewAudit,
  canManageSuperadminAccess,
  canEditConfigAssets,
  configAssets,
  error,
  usersError,
  usersMutating,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onUpsertUserIdentity,
  onDeleteUserIdentity,
  onResetUserPassword,
  selectedTab,
  onSelectTab
}: {
  usage: UsageSummary | undefined;
  auditActivities: AuditActivity[];
  users: AdministeredUser[];
  loading: boolean;
  usersLoading: boolean;
  canViewUsageGovernance: boolean;
  canManageUsers: boolean;
  canViewAudit: boolean;
  canManageSuperadminAccess: boolean;
  canEditConfigAssets: boolean;
  configAssets: ConfigAssetsPanelInput;
  error?: string;
  usersError?: string;
  usersMutating: boolean;
  onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
  onDeleteUser(userId: string): Promise<AdministeredUser>;
  onUpsertUserIdentity(
    userId: string,
    input: UpsertAdministeredUserIdentityRequest
  ): Promise<AdministeredUser>;
  onDeleteUserIdentity(userId: string, identity: AdministeredUserIdentity): Promise<AdministeredUser>;
  onResetUserPassword(userId: string, password: string): Promise<unknown>;
  selectedTab: SuperadminRouteTab;
  onSelectTab(tab: SuperadminRouteTab): void;
}) {
  const { t } = useTranslation();

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
          {canManageUsers ? (
            <TabButton
              active={selectedTab === "users"}
              icon={<Users size={15} aria-hidden="true" />}
              label={t("administrationUsers")}
              badge={users.length > 0 ? users.length : undefined}
              onClick={() => onSelectTab("users")}
            />
          ) : null}
          {canEditConfigAssets ? (
            <TabButton
              active={selectedTab === "config"}
              icon={<Settings2 size={15} aria-hidden="true" />}
              label={t("administrationConfig")}
              onClick={() => onSelectTab("config")}
            />
          ) : null}
          {canViewUsageGovernance ? (
            <TabButton
              active={selectedTab === "usage"}
              icon={<Activity size={15} aria-hidden="true" />}
              label={t("administrationUsage")}
              onClick={() => onSelectTab("usage")}
            />
          ) : null}
          {canViewAudit ? (
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

        {selectedTab === "usage" && canViewUsageGovernance ? <UsageView usage={usage} /> : null}
        {selectedTab === "users" && canManageUsers ? (
          <UserAdministrationPanel
            users={users}
            loading={usersLoading}
            error={usersError}
            canManageSuperadminAccess={canManageSuperadminAccess}
            mutating={usersMutating}
            onCreateUser={onCreateUser}
            onUpdateUser={onUpdateUser}
            onDeleteUser={onDeleteUser}
            onUpsertIdentity={onUpsertUserIdentity}
            onDeleteIdentity={onDeleteUserIdentity}
            onResetPassword={onResetUserPassword}
          />
        ) : null}
        {selectedTab === "config" && canEditConfigAssets ? (
          <ConfigAssetsPanel {...configAssets} />
        ) : null}
        {selectedTab === "audit" && canViewAudit ? (
          <AuditView auditActivities={auditActivities} />
        ) : null}
      </div>
    </section>
  );
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
