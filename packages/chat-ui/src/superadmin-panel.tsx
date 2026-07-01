import {
  Activity,
  AlertCircle,
  BarChart3,
  Bot,
  ChevronRight,
  Database,
  DollarSign,
  ScrollText,
  Search,
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
import { UserAdministrationPanel } from "./user-administration-panel";
import type { SuperadminRouteTab } from "./workspace-route";

export function SuperadminPanel({
  usage,
  auditActivities,
  users,
  loading,
  usersLoading,
  canViewUsageGovernance,
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
  return (
    <section
      className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background"
      aria-label="Administration panel"
    >
      <div className="grid gap-3 border-b px-5 pt-20">
        <div className="grid min-w-0 gap-1">
          <span className="text-xs text-muted-foreground">
            {canViewUsageGovernance ? "Superadmin" : "Admin"}
          </span>
          <h1 className="text-xl font-semibold tracking-normal">Administration</h1>
        </div>

        <nav className="flex items-end gap-1 overflow-x-auto" aria-label="Administration sections">
          {canViewUsageGovernance ? (
            <TabButton
              active={selectedTab === "usage"}
              icon={<Activity size={15} aria-hidden="true" />}
              label="Usage"
              onClick={() => onSelectTab("usage")}
            />
          ) : null}
          <TabButton
            active={selectedTab === "users"}
            icon={<Users size={15} aria-hidden="true" />}
            label="Users"
            badge={users.length > 0 ? users.length : undefined}
            onClick={() => onSelectTab("users")}
          />
          <TabButton
            active={selectedTab === "audit"}
            icon={<ScrollText size={15} aria-hidden="true" />}
            label="Audit log"
            onClick={() => onSelectTab("audit")}
          />
        </nav>
      </div>

      <div className="grid min-h-0 content-start gap-4 overflow-auto bg-background p-5">
        {selectedTab !== "users" && error ? <ErrorBanner message={error} /> : null}

        {selectedTab === "usage" && canViewUsageGovernance ? <UsageView usage={usage} /> : null}
        {selectedTab === "users" ? (
          <UserAdministrationPanel
            users={users}
            loading={usersLoading}
            error={usersError}
            canManageSuperadminAccess={canViewUsageGovernance}
            mutating={usersMutating}
            onCreateUser={onCreateUser}
            onUpdateUser={onUpdateUser}
            onDeleteUser={onDeleteUser}
            onUpsertIdentity={onUpsertUserIdentity}
            onDeleteIdentity={onDeleteUserIdentity}
            onResetPassword={onResetUserPassword}
          />
        ) : null}
        {selectedTab === "audit" ? <AuditView auditActivities={auditActivities} /> : null}
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

function UsageView({ usage }: { usage: UsageSummary | undefined }) {
  const pricing = normalizeUsagePricing(usage);
  return (
    <>
      <div className="grid gap-3 lg:grid-cols-4">
        <UsageMetric
          primary
          icon={<DollarSign size={15} />}
          label="Budgeted cost today"
          value={formatCost(usage?.today.cost)}
          detail={formatCostDetail(usage?.today.cost)}
        />
        <UsageMetric
          icon={<DollarSign size={15} />}
          label="Budgeted cost this month"
          value={formatCost(usage?.currentMonth.cost)}
          detail={formatCostDetail(usage?.currentMonth.cost)}
        />
        <UsageMetric
          icon={<DollarSign size={15} />}
          label="All-time budgeted cost"
          value={formatCost(usage?.allTime.cost)}
          detail={formatCostDetail(usage?.allTime.cost)}
        />
      </div>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Usage volume</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          <dl className="grid gap-3 md:grid-cols-4">
            <UsageStat
              icon={<Activity size={15} />}
              label="Calls today"
              value={usage?.today.modelCallCount ?? 0}
            />
            <UsageStat
              icon={<BarChart3 size={15} />}
              label="Tokens today"
              value={usage?.today.totalTokens ?? 0}
            />
            <UsageStat
              icon={<Database size={15} />}
              label="Tokens this month"
              value={usage?.currentMonth.totalTokens ?? 0}
            />
            <UsageStat
              icon={<Search size={15} />}
              label="Web searches today"
              value={usage?.today.webSearchCallCount ?? 0}
            />
          </dl>
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card data-testid="configured-budget">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Spend budget</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <dl className="grid gap-3">
              <UsageStat
                icon={<ShieldCheck size={15} />}
                label="Monthly spend limit"
                value={
                  usage?.budget.monthlySpendLimit === undefined
                    ? undefined
                    : formatCurrencyAmount(usage.budget.monthlySpendLimit, pricing.currency)
                }
              />
              <UsageStat
                icon={<ShieldCheck size={15} />}
                label="Cost safety multiplier"
                value={`${usage?.budget.costSafetyMultiplier ?? 1}x`}
              />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Configured pricing</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            {pricing.models.length + pricing.webSearch.length > 0 ? (
              <dl className="grid gap-3">
                {pricing.models.map((price) => (
                  <UsagePricing
                    key={`${price.providerId}:${price.model}`}
                    label={`${price.providerId} / ${price.model}`}
                    detail={`${formatCurrencyAmount(
                      price.inputPricePerMillionTokens,
                      pricing.currency
                    )} in / 1M, ${formatCurrencyAmount(
                      price.outputPricePerMillionTokens,
                      pricing.currency
                    )} out / 1M`}
                  />
                ))}
                {pricing.webSearch.map((price) => (
                  <UsagePricing
                    key={`${price.providerId}:${price.model ?? "*"}:web_search`}
                    icon={<Search size={15} aria-hidden="true" />}
                    label={`${price.providerId}${price.model ? ` / ${price.model}` : ""} / web_search`}
                    detail={`${formatCurrencyAmount(price.pricePerCall, pricing.currency)} / search`}
                  />
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No usage pricing configured.</p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="configured-safeguards">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-base">Configured safeguards</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-2">
            <dl className="grid gap-3">
              <UsageStat
                icon={<ShieldCheck size={15} />}
                label="Model calls per day"
                value={usage?.safeguards.modelCallsPerDay}
              />
              <UsageStat
                icon={<ShieldCheck size={15} />}
                label="Tokens per day"
                value={usage?.safeguards.tokensPerDay}
              />
              <UsageStat
                icon={<ShieldCheck size={15} />}
                label="Tokens per month"
                value={usage?.safeguards.tokensPerMonth}
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-base">Recent model usage</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-1">
          {usage?.recentEvents.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Budgeted cost</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Web search</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.recentEvents.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </TableCell>
                    <TableCell className="font-medium break-words">{event.model}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatCost(event.cost)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {event.totalTokens.toLocaleString()}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {event.webSearchCallCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{event.source}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="pt-1 text-sm text-muted-foreground">No model usage recorded yet.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function normalizeUsagePricing(usage: UsageSummary | undefined): UsageSummary["pricing"] {
  return {
    currency: usage?.pricing.currency ?? "USD",
    models: usage?.pricing.models ?? [],
    webSearch: usage?.pricing.webSearch ?? []
  };
}

function AuditView({ auditActivities }: { auditActivities: AuditActivity[] }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Recent activity</CardTitle>
        <p className="text-xs text-muted-foreground">
          Governance and workflow events, plus anything that failed or was denied. Expand a row for
          the underlying evidence.
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

function UsageMetric({
  icon,
  label,
  value,
  detail,
  primary = false
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail?: string;
  primary?: boolean;
}) {
  return (
    <Card className={cn("grid content-start gap-1.5 p-4", primary && "bg-accent/40 lg:col-span-2")}>
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <span className="grid size-6 place-items-center rounded-md bg-accent text-primary">{icon}</span>
        {label}
      </span>
      <strong className={cn("break-words text-2xl font-semibold", primary && "text-3xl")}>{value}</strong>
      {detail ? <small className="text-xs text-muted-foreground">{detail}</small> : null}
    </Card>
  );
}

function UsageStat({
  icon,
  label,
  value
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode | undefined;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <dt className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 font-medium">
        {value === undefined ? "Not configured" : typeof value === "number" ? value.toLocaleString() : value}
      </dd>
    </div>
  );
}

function UsagePricing({
  icon = <DollarSign size={15} aria-hidden="true" />,
  label,
  detail
}: {
  icon?: ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <dt className="inline-flex items-center gap-2 break-words text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium">{detail}</dd>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

type UsageCost = UsageSummary["today"]["cost"] | UsageSummary["recentEvents"][number]["cost"];

function formatCost(cost: UsageCost | undefined): string {
  if (!cost) {
    return "Not configured";
  }

  if (
    "pricedModelCallCount" in cost &&
    cost.pricedModelCallCount === 0 &&
    cost.pricedWebSearchCallCount === 0 &&
    cost.unpricedModelCallCount + cost.unpricedWebSearchCallCount > 0
  ) {
    return "No price";
  }

  if (!cost.pricingConfigured) {
    return "Not configured";
  }

  return formatCurrencyMicros(cost.budgetedCostMicros, cost.currency);
}

function formatCostDetail(cost: UsageSummary["today"]["cost"] | undefined): string | undefined {
  if (!cost) {
    return undefined;
  }

  const details: string[] = [];
  if (cost.pricingConfigured && cost.costSafetyMultiplier > 1) {
    details.push(`${formatCurrencyMicros(cost.totalCostMicros, cost.currency)} provider estimate`);
  }
  if (cost.unpricedModelCallCount) {
    details.push(
      `${cost.unpricedModelCallCount.toLocaleString()} unpriced ${
        cost.unpricedModelCallCount === 1 ? "call" : "calls"
      }`
    );
  }
  if (cost.unpricedWebSearchCallCount) {
    details.push(
      `${cost.unpricedWebSearchCallCount.toLocaleString()} unpriced ${
        cost.unpricedWebSearchCallCount === 1 ? "web search" : "web searches"
      }`
    );
  }
  return details.length > 0 ? details.join("; ") : undefined;
}

function formatCurrencyMicros(valueMicros: number, currency: string): string {
  return formatCurrencyAmount(valueMicros / 1_000_000, currency);
}

function formatCurrencyAmount(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: value < 1 ? 4 : 2,
      maximumFractionDigits: 4
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(value < 1 ? 4 : 2)}`;
  }
}
