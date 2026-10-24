import type { UsageUsers, WorkspaceMembersUsage } from "@work-shape/catalyst-api-client";
import {
  Banner,
  EmptyState,
  Field,
  FilterBar,
  Select,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { formatBillableCost, formatMicrosCost } from "./usage-cost-format";

// Usage by named person (LU-3, limits spec 3.4): listed by name and never ranked, and only for
// whoever holds `usage.view_users`. The page asks for it only while this tab is open.

/** The current UTC month and the one before, as `YYYY-MM`. */
export function usageMonths(now = new Date()): [string, string] {
  const current = now.toISOString().slice(0, 7);
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
  return [current, previous];
}

function MonthPicker({
  month,
  onMonthChange
}: {
  month: string;
  onMonthChange(month: string): void;
}) {
  const { t, locale } = useTranslation();
  const months = usageMonths();
  return (
    <FilterBar
      filters={
        <Field label={t("usageReports.month")} className="w-44">
          <Select value={month} onChange={(event) => onMonthChange(event.target.value)}>
            {months.map((value) => (
              <option key={value} value={value}>
                {new Intl.DateTimeFormat(locale, {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC"
                }).format(new Date(`${value}-01T00:00:00Z`))}
              </option>
            ))}
          </Select>
        </Field>
      }
    />
  );
}

/** Settings > Instance > Usage, Users. */
export function UsageUsersPanel({
  users,
  month,
  onMonthChange,
  error
}: {
  users: UsageUsers | undefined;
  month: string;
  onMonthChange(month: string): void;
  error?: string;
}) {
  const i18n = useTranslation();
  const { t, locale } = i18n;
  return (
    <div className="grid min-w-0 gap-4" data-testid="usage-users">
      <p className="text-caption text-muted-foreground">{t("usageReports.usersNote")}</p>
      <MonthPicker month={month} onMonthChange={onMonthChange} />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {!users ? (
        error ? null : (
          <SkeletonList />
        )
      ) : users.items.length === 0 ? (
        <EmptyState>{t("usageReports.usersEmpty")}</EmptyState>
      ) : (
        <Table narrow="stack">
          <TableHeader>
            <TableRow>
              <TableHead>{t("usageReports.person")}</TableHead>
              <TableHead align="end">{t("usageReports.spent")}</TableHead>
              <TableHead align="end">{t("usageReports.calls")}</TableHead>
              <TableHead align="end">{t("usageReports.tokens")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.items.map((item) => (
              <TableRow key={item.userId}>
                <TableCell className="break-words">{item.name}</TableCell>
                <TableCell align="end" className="whitespace-nowrap">
                  {formatMicrosCost(Math.round(item.spent * 1_000_000), users.currency, i18n)}
                </TableCell>
                <TableCell align="end" className="whitespace-nowrap text-muted-foreground">
                  {item.modelCallCount.toLocaleString(locale)}
                </TableCell>
                <TableCell align="end" className="whitespace-nowrap text-muted-foreground">
                  {item.tokens.toLocaleString(locale)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** Settings > Workspace > Usage, Members. */
export function WorkspaceMembersUsagePanel({
  members,
  month,
  onMonthChange,
  error
}: {
  members: WorkspaceMembersUsage | undefined;
  month: string;
  onMonthChange(month: string): void;
  error?: string;
}) {
  const i18n = useTranslation();
  const { t, locale } = i18n;
  return (
    <div className="grid min-w-0 gap-4" data-testid="usage-members">
      <p className="text-caption text-muted-foreground">{t("usageReports.membersNote")}</p>
      <MonthPicker month={month} onMonthChange={onMonthChange} />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {!members ? (
        error ? null : (
          <SkeletonList />
        )
      ) : members.items.length === 0 ? (
        <EmptyState>{t("usageReports.usersEmpty")}</EmptyState>
      ) : (
        <Table narrow="stack">
          <TableHeader>
            <TableRow>
              <TableHead>{t("usageReports.person")}</TableHead>
              <TableHead align="end">{t("usageReports.cost")}</TableHead>
              <TableHead align="end">{t("usageReports.calls")}</TableHead>
              <TableHead align="end">{t("usageReports.tokens")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.items.map((item, index) => (
              <TableRow key={item.userId ?? `unknown-${index}`}>
                <TableCell className="break-words">
                  {item.name ?? t("usageReports.unknownPerson")}
                </TableCell>
                <TableCell align="end" className="whitespace-nowrap">
                  {formatBillableCost(item.cost, i18n)}
                </TableCell>
                <TableCell align="end" className="whitespace-nowrap text-muted-foreground">
                  {item.modelCallCount.toLocaleString(locale)}
                </TableCell>
                <TableCell align="end" className="whitespace-nowrap text-muted-foreground">
                  {item.totalTokens.toLocaleString(locale)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
