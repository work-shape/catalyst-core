import type { ApprovalRequestView, LocaleCode } from "@vivd-catalyst/api-client";
import type { TranslationKey } from "../i18n";

/** The lists of the Inbox. */
export type InboxTab = "to_decide" | "mine" | "decided";

export const inboxTabLabelKeys: Record<InboxTab, TranslationKey> = {
  to_decide: "inbox.toDecide",
  mine: "inbox.myRequests",
  decided: "inbox.decided"
};

export const inboxTabEmptyKeys: Record<InboxTab, TranslationKey> = {
  to_decide: "inbox.emptyToDecide",
  mine: "inbox.emptyMyRequests",
  decided: "inbox.emptyDecided"
};

/** What the server counts for one person: `approval_requests.count_pending`. */
export interface InboxCounts {
  count: number;
  canReview: boolean;
  mine: { pending: number; total: number };
}

/**
 * The lists a person has. Without a right to decide a registered kind there is one, their own
 * requests, and the page then shows no tab bar: a bar of one tab is noise.
 */
export function inboxTabs(canReview: boolean): readonly InboxTab[] {
  return canReview ? ["to_decide", "mine", "decided"] : ["mine"];
}

/**
 * What the rail is given for the Inbox row: present for a person who may decide a registered
 * kind, also with nothing pending, and for a person who has made a request.
 */
export function inboxRailEntry(counts: InboxCounts | undefined): { toDecide: number } | undefined {
  return counts && (counts.canReview || counts.mine.total > 0)
    ? { toDecide: counts.count }
    : undefined;
}

/** The number in a tab's label: what waits there. The decided list counts nothing. */
export function inboxTabCount(tab: InboxTab, counts: InboxCounts | undefined): number | undefined {
  if (!counts || tab === "decided") {
    return undefined;
  }
  return tab === "to_decide" ? counts.count : counts.mine.pending;
}

/**
 * The list that holds an item: To decide while it is pending and the person can decide it, else
 * their own requests when they made it, else Decided.
 */
export function inboxTabOfItem(
  item: Pick<ApprovalRequestView, "canDecide" | "requestedBy">,
  viewer: { userId: string | undefined; canReview: boolean }
): InboxTab {
  if (!viewer.canReview) {
    return "mine";
  }
  if (item.canDecide) {
    return "to_decide";
  }
  return item.requestedBy.id === viewer.userId ? "mine" : "decided";
}

/**
 * The order of a list. To decide runs oldest first, so nothing starves. A person's own requests
 * show what still waits on top and the rest newest first. Decided runs by when it was decided.
 */
export function orderInboxItems(
  tab: InboxTab,
  items: readonly ApprovalRequestView[]
): ApprovalRequestView[] {
  const ordered = [...items];
  if (tab === "to_decide") {
    return ordered.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  if (tab === "decided") {
    return ordered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  return ordered.sort(
    (left, right) =>
      Number(right.status === "pending") - Number(left.status === "pending") ||
      right.createdAt.localeCompare(left.createdAt)
  );
}

const AGE_STEPS: readonly { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
  { unit: "year", seconds: 365 * 24 * 60 * 60 },
  { unit: "month", seconds: 30 * 24 * 60 * 60 },
  { unit: "day", seconds: 24 * 60 * 60 },
  { unit: "hour", seconds: 60 * 60 },
  { unit: "minute", seconds: 60 }
];

/**
 * How long ago something happened, in the largest unit that fits: "2 hr. ago", "vor 3 Tagen".
 * Under a minute it is "now".
 */
export function formatInboxAge(value: string, locale: LocaleCode, now: Date): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) {
    return value;
  }
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  const step = AGE_STEPS.find((candidate) => seconds >= candidate.seconds);
  return step
    ? format.format(-Math.floor(seconds / step.seconds), step.unit)
    : format.format(0, "second");
}

/**
 * Whether a list that just arrived says the open item is no longer what the page shows: its row
 * is in another state, or it left To decide while the page still offers to decide it. The item
 * is then asked for again, so nobody decides on a request someone else has decided.
 */
export function inboxListOutdatesItem(
  tab: InboxTab,
  rows: readonly Pick<ApprovalRequestView, "id" | "status" | "updatedAt">[],
  item: Pick<ApprovalRequestView, "id" | "status" | "updatedAt" | "canDecide">
): boolean {
  const row = rows.find((candidate) => candidate.id === item.id);
  if (!row) {
    return tab === "to_decide" && item.canDecide;
  }
  return row.status !== item.status || row.updatedAt > item.updatedAt;
}
