import { noticeMailSettingsSchema } from "@work-shape/catalyst-config-schema";
import {
  NOTICE_KIND,
  asUserId,
  createPlatformId,
  evaluateAccess,
  type LocaleCode,
  type UsageSpendCounter,
  type UserRecord
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";

// The instance's spend limit is reached (LU-2, limits spec 3.1): every message in every
// workspace is refused until the day or the month resets. Whoever can raise the limit learns it
// from an Inbox item of kind `notice`, once per period, in their own language. A person who
// sends a message reads the reason at the composer; this item is for those who act on it.

/** Where the job records the periods it gave notice of, in the usage ledger's maintenance rows. */
const NOTICE_TASK = "instance_limit_notice";

/** The right that raises a limit, and so the right a recipient holds. */
const RAISES_LIMITS = "limits.manage";

/** The most active users read when looking for those who hold the right. */
const USERS_READ = 1_000;

/** Who files the notice: the platform, never a person. */
const SYSTEM_REQUESTER = { id: "system", displayLabel: "System" };

type NoticeOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "usageGovernance" | "auditRecorder" | "config" | "mail"
>;

type Period = UsageSpendCounter["period"];

/** The first UTC day of the period `now` is in, as the counters key it. */
function periodStart(period: Period, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return period === "day" ? day : `${day.slice(0, 8)}01`;
}

/**
 * One run: for the current UTC day and month, where the instance's counter has reached its
 * limit as admission holds it and no notice of that period went out yet, files one notice to
 * each active holder of `limits.manage`. Resolves with the periods noticed.
 */
export async function noticeReachedInstanceLimit(
  options: NoticeOptions,
  input: { now: Date }
): Promise<Period[]> {
  const { clientInstanceId, stores, usageGovernance } = options;
  const [records, counters] = await Promise.all([
    stores.usage.listSpendLimits({ clientInstanceId }),
    // Without users or workspaces named, only the instance's counters.
    stores.usage.readSpendCounters({ clientInstanceId })
  ]);
  const limits = usageGovernance.instanceSpendLimits(
    records.find((record) => record.level === "instance")
  );
  const ceiling = usageGovernance.spendCeiling();
  const reached = (["day", "month"] as const).flatMap((period) => {
    const limitMicros = period === "day" ? limits.dailyMicros : limits.monthlyMicros;
    if (limitMicros === undefined) return [];
    const spent =
      counters.find((counter) => counter.scopeKind === "instance" && counter.period === period)
        ?.costMicros ?? 0;
    if (spent < usageGovernance.heldSpend(limitMicros)) return [];
    const ceilingMicros = period === "day" ? ceiling.dailyMicros : ceiling.monthlyMicros;
    return [{ period, limitMicros, atCeiling: ceilingMicros === limitMicros }];
  });
  if (reached.length === 0) return [];

  const done = await stores.usage.readModelUsageMaintenance({
    clientInstanceId,
    task: NOTICE_TASK
  });
  const due = reached.filter(({ period }) => done?.[period] !== periodStart(period, input.now));
  if (due.length === 0) return [];

  const recipients = await limitManagers(options);
  const currency = usageGovernance.spendCurrency();
  const delivery = noticeMailSettingsSchema.parse(
    options.config.infrastructure.mail?.notices ?? {}
  );
  const dueAt = new Date(input.now.getTime() + delivery.digestIntervalMs).toISOString();
  let mailsQueued = 0;
  await stores.transaction(async (tx) => {
    // A tick runs alone across the instance, so what it read above still stands here.
    await tx.usage.writeModelUsageMaintenance({
      clientInstanceId,
      task: NOTICE_TASK,
      state: {
        ...done,
        ...Object.fromEntries(due.map(({ period }) => [period, periodStart(period, input.now)]))
      }
    });
    for (const user of recipients) {
      const locale = user.locale ?? options.config.localization.defaultLocale;
      for (const reach of due) {
        const content = noticeContent(locale, { ...reach, currency });
        const item = await tx.approvals.createApprovalRequest({
          clientInstanceId,
          kind: NOTICE_KIND,
          summary: content.title,
          payload: content,
          requestedBy: SYSTEM_REQUESTER,
          addresseeUserId: user.id
        });
        if (options.mail && user.email) {
          await tx.noticeMail.enqueue({
            clientInstanceId,
            noticeId: item.id,
            userId: asUserId(user.id),
            dueAt
          });
          mailsQueued += 1;
        }
      }
    }
  });
  if (recipients.length > 0) {
    await options.auditRecorder.record({
      type: "notice.sent",
      status: "success",
      correlationId: createPlatformId("corr"),
      metadata: {
        channels: options.mail ? ["inbox", "mail"] : ["inbox"],
        addressees: recipients.length,
        inactive: 0,
        mailsSent: 0,
        mailsQueued,
        mailsUnsent: options.mail ? recipients.filter((user) => !user.email).length * due.length : 0
      }
    });
  }
  return due.map(({ period }) => period);
}

/** The active people who hold `limits.manage` on the instance, a deny of theirs heeded. */
async function limitManagers(options: NoticeOptions): Promise<UserRecord[]> {
  const { clientInstanceId, stores } = options;
  const users = await stores.users.listUsers({
    clientInstanceId,
    activeOnly: true,
    page: { limit: USERS_READ }
  });
  const holders: UserRecord[] = [];
  for (const user of users) {
    const persisted = await stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "user", id: user.id }
    });
    if (!persisted.holderActive) continue;
    const decision = evaluateAccess({
      holder: {
        kind: "user",
        id: user.id,
        clientInstanceId: user.clientInstanceId,
        roles: user.roles,
        permissionRefs: user.permissionRefs
      },
      persisted,
      action: RAISES_LIMITS
    });
    if (decision.allowed) holders.push(user);
  }
  return holders;
}

/** The notice in the person's language: which limit, its amount, when it resets, who raises it. */
function noticeContent(
  locale: LocaleCode,
  input: { period: Period; limitMicros: number; atCeiling: boolean; currency?: string }
): { title: string; text: string } {
  const german = locale.toLowerCase().startsWith("de");
  const amount = new Intl.NumberFormat(german ? "de-DE" : "en-GB", {
    ...(input.currency ? { style: "currency", currency: input.currency } : {}),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(input.limitMicros / 1_000_000);
  const day = input.period === "day";
  if (german) {
    const which = day ? "tägliche" : "monatliche";
    return {
      title: `Das ${which} Ausgabenlimit für alle Arbeitsbereiche ist erreicht`,
      text: [
        `Alle Arbeitsbereiche zusammen haben ihr ${which}s Ausgabenlimit von ${amount} erreicht.`,
        `Bis es ${day ? "um Mitternacht UTC" : "zu Beginn des nächsten Monats (UTC)"} zurückgesetzt wird, wird in keinem Arbeitsbereich eine Nachricht beantwortet.`,
        input.atCeiling
          ? "Das ist die Obergrenze des technischen Teams: nur das technische Team kann sie erhöhen."
          : "Du kannst es unter Einstellungen › Alle Arbeitsbereiche › Limits erhöhen, bis zur Obergrenze des technischen Teams."
      ].join(" ")
    };
  }
  const which = day ? "daily" : "monthly";
  return {
    title: `The ${which} spend limit for all workspaces is reached`,
    text: [
      `All workspaces together have reached their ${which} spend limit of ${amount}.`,
      `Until it resets ${day ? "at midnight UTC" : "at the start of next month (UTC)"}, no message is answered in any workspace.`,
      input.atCeiling
        ? "This is the technical team's upper limit: only the technical team can raise it."
        : "You can raise it under Settings › All workspaces › Limits, up to the technical team's upper limit."
    ].join(" ")
  };
}
