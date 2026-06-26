import {
  Activity,
  AlertCircle,
  BarChart3,
  Database,
  DollarSign,
  ScrollText,
  ShieldCheck,
  Users
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
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
  auditEvents,
  users,
  loading,
  usersLoading,
  error,
  usersError,
  usersMutating,
  onCreateUser,
  onUpdateUser,
  onUpsertUserIdentity,
  onDeleteUserIdentity,
  onResetUserPassword,
  selectedTab,
  onSelectTab
}: {
  usage: UsageSummary | undefined;
  auditEvents: AuditEvent[];
  users: AdministeredUser[];
  loading: boolean;
  usersLoading: boolean;
  error?: string;
  usersError?: string;
  usersMutating: boolean;
  onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
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
      aria-label="Superadmin panel"
    >
      <div className="grid gap-3 border-b px-5 pt-20">
        <div className="grid min-w-0 gap-1">
          <span className="text-xs text-muted-foreground">Superadmin</span>
          <h1 className="text-xl font-semibold tracking-normal">Administration</h1>
        </div>

        <nav className="flex items-end gap-1 overflow-x-auto" aria-label="Superadmin sections">
          <TabButton
            active={selectedTab === "usage"}
            icon={<Activity size={15} aria-hidden="true" />}
            label="Usage"
            onClick={() => onSelectTab("usage")}
          />
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

        {selectedTab === "usage" ? <UsageView usage={usage} /> : null}
        {selectedTab === "users" ? (
          <UserAdministrationPanel
            users={users}
            loading={usersLoading}
            error={usersError}
            mutating={usersMutating}
            onCreateUser={onCreateUser}
            onUpdateUser={onUpdateUser}
            onUpsertIdentity={onUpsertUserIdentity}
            onDeleteIdentity={onDeleteUserIdentity}
            onResetPassword={onResetUserPassword}
          />
        ) : null}
        {selectedTab === "audit" ? <AuditView auditEvents={auditEvents} /> : null}
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
          <dl className="grid gap-3 md:grid-cols-3">
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
                    : formatCurrencyAmount(usage.budget.monthlySpendLimit, usage.pricing.currency)
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
            {usage?.pricing.models.length ? (
              <dl className="grid gap-3">
                {usage.pricing.models.map((price) => (
                  <UsagePricing
                    key={`${price.providerId}:${price.model}`}
                    currency={usage.pricing.currency}
                    label={`${price.providerId} / ${price.model}`}
                    inputPrice={price.inputPricePerMillionTokens}
                    outputPrice={price.outputPricePerMillionTokens}
                  />
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No model pricing configured.</p>
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

function AuditView({ auditEvents }: { auditEvents: AuditEvent[] }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Recent audit events</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-1">
        {auditEvents.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Subject</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditEvents.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDateTime(event.createdAt)}
                  </TableCell>
                  <TableCell className="font-medium break-words">{event.type}</TableCell>
                  <TableCell>
                    <Badge
                      variant={event.status === "success" ? "success" : "outline"}
                      className="capitalize"
                    >
                      {event.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {event.actor?.displayLabel ?? "-"}
                  </TableCell>
                  <TableCell className="break-all text-muted-foreground">
                    {event.subject ?? "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="pt-1 text-sm text-muted-foreground">No audit events visible yet.</p>
        )}
      </CardContent>
    </Card>
  );
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
  currency,
  label,
  inputPrice,
  outputPrice
}: {
  currency: string;
  label: string;
  inputPrice: number;
  outputPrice: number;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <dt className="inline-flex items-center gap-2 break-words text-xs text-muted-foreground">
        <DollarSign size={15} aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium">
        {formatCurrencyAmount(inputPrice, currency)} in / 1M,{" "}
        {formatCurrencyAmount(outputPrice, currency)} out / 1M
      </dd>
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
    cost.unpricedModelCallCount > 0
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
