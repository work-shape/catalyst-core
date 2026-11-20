import type { BadgeTone } from "@work-shape/catalyst-ui";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
import { formatElapsed } from "../../shared/locale-format";
import { scheduleInWords } from "../workflows/schedule-words";
import { KNOWLEDGE_DOCUMENT_FAILURES } from "./knowledge-base-model";
import {
  sourceNextSyncAt,
  type KnowledgeSourceFailureCode,
  type KnowledgeSourceStatus
} from "./knowledge-base-source";
import {
  knowledgeSourcesToConfig,
  SYNC_OFF,
  type KnowledgeSourceForm
} from "./knowledge-sources-model";

// How a synced source of a published Knowledge Base stands, as its page shows it.

/** The badge a synced source shows: what its sync does now, or how the last one ended. */
export interface SourceStateView {
  state:
    "initial" | "waiting" | "syncing" | "current" | "unreachable" | "refused" | "failed" | "never";
  tone: BadgeTone;
  label: TranslationKey;
}

/** How a source stands, from its running sync and its last one. */
export function sourceStateView(
  status: Pick<KnowledgeSourceStatus, "running" | "last" | "confirmation">
): SourceStateView {
  // A first import above 10,000 items waits for a person (KB-ISO-1b).
  if (status.running !== undefined && status.confirmation !== undefined)
    return { state: "waiting", tone: "warning", label: "knowledgeSources.stateWaiting" };
  if (status.running !== undefined) {
    if (status.running.mode === "ingest")
      return { state: "syncing", tone: "info", label: "knowledgeSources.stateIngesting" };
    return status.running.mode === "initial"
      ? { state: "initial", tone: "info", label: "knowledgeSources.stateInitial" }
      : { state: "syncing", tone: "info", label: "knowledgeSources.stateSyncing" };
  }
  const last = status.last;
  if (last === undefined) {
    return { state: "never", tone: "neutral", label: "knowledgeSources.stateNever" };
  }
  if (last.state !== "failed") {
    return { state: "current", tone: "success", label: "knowledgeSources.stateCurrent" };
  }
  if (last.failureCode === "knowledge_source_unreachable") {
    return { state: "unreachable", tone: "danger", label: "knowledgeSources.stateUnreachable" };
  }
  if (last.failureCode === "knowledge_ingest_cancelled") {
    return { state: "failed", tone: "warning", label: "knowledgeSources.stateRunEnded" };
  }
  if (last.failureCode === "knowledge_source_refused") {
    return { state: "refused", tone: "danger", label: "knowledgeSources.stateRefused" };
  }
  return { state: "failed", tone: "danger", label: "knowledgeSources.stateFailed" };
}

/** The items a source found that are still in it, and of those the searchable and the failed. */
export function sourceItemCounts(items: KnowledgeSourceStatus["items"]): {
  found: number;
  searchable: number;
  failed: number;
} {
  return {
    found: items.discovered + items.fetched + items.indexed + items.failed,
    searchable: items.indexed,
    failed: items.failed
  };
}

/** Why items of a source failed, in a sentence a person reads: one for every code. */
export function sourceFailureText(code: KnowledgeSourceFailureCode): TranslationKey {
  switch (code) {
    case "knowledge_source_unreachable":
      return "knowledgeSources.failureUnreachable";
    case "knowledge_source_refused":
      return "knowledgeSources.failureRefused";
    case "knowledge_fetch_failed":
      return "knowledgeSources.failureFetch";
    case "knowledge_source_limit_reached":
      return "knowledgeSources.failureLimit";
    case "knowledge_item_invalid":
      return "knowledgeSources.failureItemInvalid";
    case "knowledge_fetch_not_allowed":
      return "knowledgeSources.failureNotAllowed";
    case "knowledge_ingest_cancelled":
      return "knowledgeSources.failureIngestCancelled";
    case "knowledge_item_removed":
      return "knowledgeSources.failureItemRemoved";
    default:
      return KNOWLEDGE_DOCUMENT_FAILURES[code];
  }
}

const MINUTE_MS = 60_000;

/**
 * What a published source does right now, in the one line of its card: the sync that runs with
 * how many of its items are through, or when it last synced and when it syncs next. It says
 * nothing where the badge says all there is: a source that never synced, and a first import
 * that waits for a person.
 */
export function sourceLiveLine(
  status: Pick<KnowledgeSourceStatus, "running" | "last" | "confirmation" | "items" | "schedule">,
  now: Date,
  translation: Pick<TranslationContextValue, "locale" | "t">
): string | undefined {
  const { locale, t } = translation;
  if (status.running !== undefined) {
    if (status.confirmation !== undefined) return undefined;
    const counts = sourceItemCounts(status.items);
    const label = t(sourceStateView(status).label);
    // A count says something only while items still wait: a changes sync of a source that is
    // through would read "8 of 8" the whole time.
    const done = counts.searchable + counts.failed;
    if (counts.found === 0 || done >= counts.found)
      return t("knowledgeSources.liveRunning", { state: label });
    const number = new Intl.NumberFormat(locale);
    return t("knowledgeSources.liveRunningProgress", {
      state: label,
      done: number.format(done),
      total: number.format(counts.found)
    });
  }
  const last = status.last;
  if (last === undefined) return undefined;
  const lastLine = t(
    last.state === "failed" ? "knowledgeSources.liveLastFailed" : "knowledgeSources.liveLast",
    { elapsed: formatElapsed(last.endedAt ?? last.startedAt, now, locale) }
  );
  const next = sourceNextSyncAt(status);
  if (next !== undefined) {
    return next.getTime() - now.getTime() < MINUTE_MS
      ? t("knowledgeSources.liveNextDue", { last: lastLine })
      : t("knowledgeSources.liveNextIn", {
          last: lastLine,
          // The time left, in the units the time since is said in.
          remaining: formatElapsed(now.toISOString(), next, locale)
        });
  }
  // One that fetches no changes by itself is compared with its source at its full sync alone.
  const full = status.schedule?.full;
  const fullWords =
    full === undefined || full === SYNC_OFF ? undefined : scheduleInWords(full, translation);
  return fullWords === undefined
    ? t("knowledgeSources.liveLastOnly", { last: lastLine })
    : t("knowledgeSources.liveNextFull", {
        last: lastLine,
        full: fullWords.charAt(0).toLocaleLowerCase(locale) + fullWords.slice(1)
      });
}

/**
 * What of a source the draft changed and the live revision does not hold yet: its folders, the
 * addresses of one of web pages, or another setting. Absent where both hold the same, and for a
 * source the live revision does not have.
 */
export function sourceDraftChange(
  draft: KnowledgeSourceForm,
  live: readonly KnowledgeSourceForm[] | undefined
): "folders" | "addresses" | "settings" | undefined {
  const published = live?.find((entry) => entry.id === draft.id);
  if (published === undefined) return undefined;
  const [set] = knowledgeSourcesToConfig([draft]);
  const [held] = knowledgeSourcesToConfig([published]);
  if (set === undefined || held === undefined) return undefined;
  const same = (keys: readonly string[]) =>
    keys.every((key) => JSON.stringify(set[key]) === JSON.stringify(held[key]));
  if (!same(["folders"])) return "folders";
  if (!same(["pages", "prefixes", "sitemaps"])) return "addresses";
  return same([...new Set([...Object.keys(set), ...Object.keys(held)])]) ? undefined : "settings";
}
