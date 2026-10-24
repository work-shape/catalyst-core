import type { OwnUsage, UsageSpendPeriod } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";

// What the composer says about the spend limits (LU-2, limits spec 3.1): one sentence when a
// limit stops the person, naming which limit, when it resets and that an administrator can
// raise it, and a quiet note with the amount left from 80 percent of their own limit on. The
// person's own amounts are always theirs to read; a workspace's only for its owners and
// admins, the instance's never here. The server leaves out what the person may not read.

type Period = keyof OwnUsage["own"];
type Level = "own" | "workspace" | "instance";

const BLOCKED: Record<Level, Record<Period, { amount?: TranslationKey; plain: TranslationKey }>> = {
  own: {
    day: { amount: "composerLimit.ownDay", plain: "composerLimit.ownDayPlain" },
    month: { amount: "composerLimit.ownMonth", plain: "composerLimit.ownMonthPlain" }
  },
  workspace: {
    day: { amount: "composerLimit.workspaceDayAmount", plain: "composerLimit.workspaceDay" },
    month: {
      amount: "composerLimit.workspaceMonthAmount",
      plain: "composerLimit.workspaceMonth"
    }
  },
  instance: {
    day: { plain: "composerLimit.instanceDay" },
    month: { plain: "composerLimit.instanceMonth" }
  }
};

const NEAR: Record<Period, TranslationKey> = {
  day: "composerLimit.nearDay",
  month: "composerLimit.nearMonth"
};

/** From this share of their own limit on, a person reads how much is left. */
const NEAR_SHARE = 0.8;

/** An amount in the rate card's currency, in the person's language. */
export function formatSpend(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

/**
 * The sentence that stops the composer, or nothing. The person's own limit is named first,
 * then the workspace's, then the instance's; of one level the day before the month.
 */
export function usageLimitBlockReason(
  usage: OwnUsage | undefined,
  { t, locale }: Pick<TranslationContextValue, "t" | "locale">
): string | undefined {
  if (!usage) return undefined;
  const levels: [Level, OwnUsage["own"] | undefined][] = [
    ["own", usage.own],
    ["workspace", usage.workspace],
    ["instance", usage.instance]
  ];
  for (const [level, status] of levels) {
    if (!status) continue;
    for (const period of ["day", "month"] as const) {
      const state: UsageSpendPeriod = status[period];
      if (state.reached !== true) continue;
      const keys = BLOCKED[level][period];
      const { currency } = usage;
      if (
        keys.amount !== undefined &&
        currency !== undefined &&
        state.spent !== undefined &&
        state.limit !== undefined
      ) {
        return t(keys.amount, {
          spent: formatSpend(state.spent, currency, locale),
          limit: formatSpend(state.limit, currency, locale)
        });
      }
      return t(keys.plain);
    }
  }
  return undefined;
}

/**
 * Whether a person has used 80 percent of a limit: of what admission holds them to, `spent`
 * and `left` together, the same measure `reached` is taken against.
 */
export function nearLimit(spent: number, left: number): boolean {
  return spent > 0 && spent >= (spent + left) * NEAR_SHARE;
}

/** The quiet note at 80 percent of the person's own limit, once per period. */
export interface UsageNearNote {
  /** Names the limit and its period, so a dismissed note stays away until the period ends. */
  key: string;
  text: string;
}

/** The note for the person's own limit they are closest to, from 80 percent on, or nothing. */
export function usageNearNote(
  usage: OwnUsage | undefined,
  { t, locale }: Pick<TranslationContextValue, "t" | "locale">
): UsageNearNote | undefined {
  const currency = usage?.currency;
  if (!usage || currency === undefined) return undefined;
  for (const period of ["day", "month"] as const) {
    const { spent, left, reached, resetsAt } = usage.own[period];
    if (reached === true || spent === undefined || left === undefined) continue;
    // Measured as `reached` is: against what admission holds the person to.
    if (!nearLimit(spent, left)) continue;
    return {
      key: `${period}:${resetsAt}`,
      text: t(NEAR[period], { amount: formatSpend(left, currency, locale) })
    };
  }
  return undefined;
}
