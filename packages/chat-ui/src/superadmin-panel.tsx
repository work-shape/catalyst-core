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
import { useState, type ReactNode } from "react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  AuditEvent,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest,
  UsageSummary
} from "@agent-chat-platform/api-client";
import { Badge } from "./ui/badge";
import { cn } from "./ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { UserAdministrationPanel } from "./user-administration-panel";

type SuperadminTab = "usage" | "users" | "audit";

export function SuperadminPanel({
  usage,
  auditEvents,
  users,
  loading,
  usersLoading,
  error,
  usersError,
  usersMutating,
  headerActions,
  onCreateUser,
  onUpdateUser,
  onUpsertUserIdentity,
  onDeleteUserIdentity,
  onResetUserPassword
}: {
  usage: UsageSummary | undefined;
  auditEvents: AuditEvent[];
  users: AdministeredUser[];
  loading: boolean;
  usersLoading: boolean;
  error?: string;
  usersError?: string;
  usersMutating: boolean;
  headerActions?: ReactNode;
  onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
  onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
  onUpsertUserIdentity(
    userId: string,
    input: UpsertAdministeredUserIdentityRequest
  ): Promise<AdministeredUser>;
  onDeleteUserIdentity(userId: string, identity: AdministeredUserIdentity): Promise<AdministeredUser>;
  onResetUserPassword(userId: string, password: string): Promise<unknown>;
}) {
  const [tab, setTab] = useState<SuperadminTab>("usage");
  const isLoading = tab === "users" ? usersLoading : loading;

  return (
    <section
      className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[#f6f7f9] text-slate-900"
      aria-label="Superadmin panel"
    >
      <header className="z-10 flex min-h-[60px] min-w-0 items-center gap-4 border-b border-slate-200 bg-white/85 px-5 py-2 backdrop-blur">
        <div className="grid min-w-0 leading-tight">
          <span className="truncate text-[11px] font-semibold tracking-[0.06em] text-slate-400 uppercase">
            Superadmin
          </span>
          <strong className="truncate text-sm font-semibold text-slate-900">Administration</strong>
          <span className="sr-only">Usage and governance</span>
        </div>

        <nav
          className="flex min-w-0 shrink overflow-x-auto rounded-[10px] bg-slate-100 p-[3px]"
          role="tablist"
          aria-label="Superadmin sections"
        >
          <TabButton
            active={tab === "usage"}
            icon={<Activity size={15} aria-hidden="true" />}
            label="Usage"
            onClick={() => setTab("usage")}
          />
          <TabButton
            active={tab === "users"}
            icon={<Users size={15} aria-hidden="true" />}
            label="Users"
            badge={users.length > 0 ? users.length : undefined}
            onClick={() => setTab("users")}
          />
          <TabButton
            active={tab === "audit"}
            icon={<ScrollText size={15} aria-hidden="true" />}
            label="Audit log"
            onClick={() => setTab("audit")}
          />
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="hidden rounded-lg border-slate-200 bg-white text-slate-500 sm:inline-flex">
            <span className={cn("size-2 rounded-full", isLoading ? "bg-amber-500" : "bg-emerald-600")} />
            {isLoading ? "Loading" : "Live"}
          </Badge>
          {headerActions}
        </div>
      </header>

      <div className="min-h-0 overflow-auto px-4 py-6 sm:px-6">
        <div className="mx-auto grid max-w-[1180px] content-start gap-4">
          {tab !== "users" && error ? <ErrorBanner message={error} /> : null}
          {tab === "usage" ? <UsageView usage={usage} /> : null}
          {tab === "users" ? (
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
          {tab === "audit" ? <AuditView auditEvents={auditEvents} /> : null}
        </div>
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
      role="tab"
      aria-selected={active}
      className={cn(
        "inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium text-slate-600 transition-colors outline-none hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-100",
        active && "bg-white text-slate-900 shadow-sm"
      )}
      onClick={onClick}
    >
      {icon}
      {label}
      {badge !== undefined ? (
        <span className="rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-500">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function PageHead({
  title,
  description,
  actions
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="grid min-w-0 gap-1">
        <h1 className="truncate text-[22px] font-semibold tracking-normal text-slate-950">{title}</h1>
        <p className="text-sm text-slate-500">{description}</p>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="inline-flex w-fit max-w-[min(42rem,100%)] items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <AlertCircle size={17} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function UsageView({ usage }: { usage: UsageSummary | undefined }) {
  return (
    <>
      <PageHead
        title="Usage"
        description="Budgeted model usage, configured pricing, safeguards, and recent model calls."
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <UsageMetric
          label="Budgeted cost today"
          value={formatCost(usage?.today.cost)}
          detail={formatCostDetail(usage?.today.cost)}
        />
        <UsageMetric
          label="Budgeted cost this month"
          value={formatCost(usage?.currentMonth.cost)}
          detail={formatCostDetail(usage?.currentMonth.cost)}
        />
        <UsageMetric
          label="Calls today"
          value={(usage?.today.modelCallCount ?? 0).toLocaleString()}
          detail={`${(usage?.currentMonth.modelCallCount ?? 0).toLocaleString()} this month`}
        />
        <UsageMetric
          label="Tokens this month"
          value={(usage?.currentMonth.totalTokens ?? 0).toLocaleString()}
          detail={`${(usage?.today.totalTokens ?? 0).toLocaleString()} today`}
        />
      </div>

      <PanelCard>
        <div className="px-4 pt-4 text-sm font-semibold text-slate-900">Recent model token volume</div>
        <UsageBars usage={usage} />
      </PanelCard>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <PanelCard data-testid="configured-budget">
          <PanelHeading title="Spend budget" />
          <div className="grid gap-3 p-4 pt-2 md:grid-cols-2">
            <UsageStat
              icon={<ShieldCheck size={15} aria-hidden="true" />}
              label="Monthly spend limit"
              value={
                usage?.budget.monthlySpendLimit === undefined
                  ? undefined
                  : formatCurrencyAmount(usage.budget.monthlySpendLimit, usage.pricing.currency)
              }
            />
            <UsageStat
              icon={<ShieldCheck size={15} aria-hidden="true" />}
              label="Cost safety multiplier"
              value={`${usage?.budget.costSafetyMultiplier ?? 1}x`}
            />
          </div>
        </PanelCard>

        <PanelCard data-testid="configured-safeguards">
          <PanelHeading title="Configured safeguards" />
          <div className="grid gap-3 p-4 pt-2 md:grid-cols-3 xl:grid-cols-1">
            <UsageStat
              icon={<ShieldCheck size={15} aria-hidden="true" />}
              label="Model calls per day"
              value={usage?.safeguards.modelCallsPerDay}
            />
            <UsageStat
              icon={<ShieldCheck size={15} aria-hidden="true" />}
              label="Tokens per day"
              value={usage?.safeguards.tokensPerDay}
            />
            <UsageStat
              icon={<ShieldCheck size={15} aria-hidden="true" />}
              label="Tokens per month"
              value={usage?.safeguards.tokensPerMonth}
            />
          </div>
        </PanelCard>
      </div>

      <PanelCard>
        <PanelHeading title="Configured pricing" />
        <div className="grid gap-3 p-4 pt-2">
          {usage?.pricing.models.length ? (
            usage.pricing.models.map((price) => (
              <UsagePricing
                key={`${price.providerId}:${price.model}`}
                currency={usage.pricing.currency}
                label={`${price.providerId} / ${price.model}`}
                inputPrice={price.inputPricePerMillionTokens}
                outputPrice={price.outputPricePerMillionTokens}
              />
            ))
          ) : (
            <p className="text-sm text-slate-500">No model pricing configured.</p>
          )}
        </div>
      </PanelCard>

      <PanelCard>
        <PanelHeading title="Recent model usage" />
        {usage?.recentEvents.length ? (
          <Table>
            <TableHeader>
              <TableRow className="border-slate-200 bg-slate-50 hover:bg-slate-50">
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Time
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Model
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Budgeted cost
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Tokens
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Source
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.recentEvents.map((event) => (
                <TableRow key={event.id} className="border-slate-200 hover:bg-slate-50">
                  <TableCell className="px-4 text-slate-500">{formatDateTime(event.createdAt)}</TableCell>
                  <TableCell className="px-4 font-medium break-words text-slate-900">{event.model}</TableCell>
                  <TableCell className="px-4 whitespace-nowrap text-slate-700">
                    {formatCost(event.cost)}
                  </TableCell>
                  <TableCell className="px-4 whitespace-nowrap text-slate-500">
                    {event.totalTokens.toLocaleString()}
                  </TableCell>
                  <TableCell className="px-4 text-slate-500">{event.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="No model usage recorded yet." />
        )}
      </PanelCard>
    </>
  );
}

function UsageBars({ usage }: { usage: UsageSummary | undefined }) {
  const bars = usage?.recentEvents.slice(0, 14).reverse() ?? [];
  const maxTokens = Math.max(1, ...bars.map((event) => event.totalTokens));

  if (bars.length === 0) {
    return <EmptyState title="No recent model calls to chart." />;
  }

  return (
    <div className="flex h-[200px] items-end gap-2 px-4 pt-5 pb-4">
      {bars.map((event) => {
        const height = Math.max(8, Math.round((event.totalTokens / maxTokens) * 100));
        return (
          <div
            key={event.id}
            className="min-h-2 flex-1 rounded-t-md rounded-b-sm bg-linear-to-b from-sky-400 to-sky-600"
            style={{ height: `${height}%` }}
            title={`${event.model}: ${event.totalTokens.toLocaleString()} tokens`}
          />
        );
      })}
    </div>
  );
}

function AuditView({ auditEvents }: { auditEvents: AuditEvent[] }) {
  return (
    <>
      <PageHead title="Audit log" description="Recent minimized governance and platform events." />
      <PanelCard>
        <PanelHeading title="Recent audit events" />
        {auditEvents.length ? (
          <Table>
            <TableHeader>
              <TableRow className="border-slate-200 bg-slate-50 hover:bg-slate-50">
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Time
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Event
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Status
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Actor
                </TableHead>
                <TableHead className="px-4 text-[11px] font-semibold tracking-[0.05em] text-slate-400 uppercase">
                  Subject
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditEvents.map((event) => (
                <TableRow key={event.id} className="border-slate-200 hover:bg-slate-50">
                  <TableCell className="px-4 text-slate-500">{formatDateTime(event.createdAt)}</TableCell>
                  <TableCell className="px-4 font-medium break-words text-slate-900">{event.type}</TableCell>
                  <TableCell className="px-4">
                    <StatusPill tone={event.status === "success" ? "green" : "slate"}>{event.status}</StatusPill>
                  </TableCell>
                  <TableCell className="px-4 text-slate-500">{event.actor?.displayLabel ?? "-"}</TableCell>
                  <TableCell className="px-4 break-all text-slate-500">{event.subject ?? "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState title="No audit events visible yet." />
        )}
      </PanelCard>
    </>
  );
}

function UsageMetric({
  label,
  value,
  detail
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold tracking-[0.02em] text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tracking-normal text-slate-950">{value}</div>
      {detail ? <div className="mt-1 text-xs font-medium text-slate-500">{detail}</div> : null}
    </div>
  );
}

function PanelCard({
  className,
  children,
  ...props
}: {
  className?: string;
  children: ReactNode;
  [key: string]: unknown;
}) {
  return (
    <div
      className={cn("overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm", className)}
      {...props}
    >
      {children}
    </div>
  );
}

function PanelHeading({ title }: { title: string }) {
  return <div className="px-4 pt-4 pb-2 text-sm font-semibold text-slate-900">{title}</div>;
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
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <dt className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
        <span className="text-sky-700">{icon}</span>
        {label}
      </dt>
      <dd className="mt-1 font-semibold text-slate-900">
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
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <dt className="inline-flex items-center gap-2 break-words text-xs font-medium text-slate-500">
        <DollarSign size={15} aria-hidden="true" className="text-sky-700" />
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-slate-900">
        {formatCurrencyAmount(inputPrice, currency)} in / 1M,{" "}
        {formatCurrencyAmount(outputPrice, currency)} out / 1M
      </dd>
    </div>
  );
}

function StatusPill({
  tone,
  children
}: {
  tone: "green" | "amber" | "slate";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize",
        tone === "green" && "bg-emerald-50 text-emerald-700",
        tone === "amber" && "bg-amber-50 text-amber-700",
        tone === "slate" && "bg-slate-100 text-slate-500"
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "green" && "bg-emerald-600",
          tone === "amber" && "bg-amber-600",
          tone === "slate" && "bg-slate-400"
        )}
      />
      {children}
    </span>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="grid justify-items-center gap-1 px-4 py-10 text-center text-sm text-slate-500">
      <BarChart3 size={18} aria-hidden="true" className="text-slate-400" />
      <strong className="font-semibold text-slate-600">{title}</strong>
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
