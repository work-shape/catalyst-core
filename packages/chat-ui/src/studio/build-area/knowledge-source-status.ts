import type { BadgeTone } from "@work-shape/catalyst-ui";
import type { TranslationKey } from "../../shared/i18n";
import { KNOWLEDGE_DOCUMENT_FAILURES } from "./knowledge-base-model";
import type { KnowledgeSourceFailureCode, KnowledgeSourceStatus } from "./knowledge-base-source";

// How a synced source of a published Knowledge Base stands, as its page shows it.

/** The badge a synced source shows: what its sync does now, or how the last one ended. */
export interface SourceStateView {
  state: "initial" | "syncing" | "current" | "unreachable" | "refused" | "failed" | "never";
  tone: BadgeTone;
  label: TranslationKey;
}

/** How a source stands, from its running sync and its last one. */
export function sourceStateView(
  status: Pick<KnowledgeSourceStatus, "running" | "last">
): SourceStateView {
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
