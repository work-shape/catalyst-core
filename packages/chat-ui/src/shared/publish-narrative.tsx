import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  Banner,
  Button,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  InlineError,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { publishNarrativeSchema, type PublishNarrative } from "@work-shape/catalyst-api-client";
import { useTranslation } from "./i18n";

// The lead of every publish question (PUBQ-1): the instance's one plain sentence on what the
// publish makes live, its warnings before the click, and the lists the question had before
// behind "Details". The App's Publish dialog, the Workflow's publish question and the Inbox
// item of a held publish show the same sentence; the instance words it in the reader's
// language, from names and counts only.

/** The instance's sentence on a publish and what will stop it, as `publishNarrative`. */
type PublishNarrativeView = PublishNarrative;

/**
 * What an answer says of the narrative. `absent` is an answer without one, as from a sample or
 * an instance from before PUBQ-1; `malformed` is one that holds a narrative this client cannot
 * read whole. A malformed narrative is never shown in part: a dropped warning would let the
 * question be answered without it.
 */
type ParsedPublishNarrative =
  | { status: "absent" }
  | { status: "malformed" }
  | { status: "present"; narrative: PublishNarrativeView };

/** Reads `publishNarrative` of an answer by the contract's schema. */
export function parsePublishNarrative(value: unknown): ParsedPublishNarrative {
  // Only a missing property is no narrative; `null` is a present one the schema refuses.
  if (value === undefined) return { status: "absent" };
  const parsed = publishNarrativeSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.summary.trim() === "" ||
    parsed.data.warnings.some((warning) => warning.trim() === "")
  ) {
    return { status: "malformed" };
  }
  return { status: "present", narrative: parsed.data };
}

/** The narrative of one revision as a question reads it. */
export type PublishNarrativeRead =
  /** The source words no sentence, as samples or an instance without a narrator. */
  | { status: "none" }
  | { status: "loading" }
  /** The read failed, or its answer held a narrative this client cannot read whole. */
  | { status: "failed"; reason: "read" | "malformed"; retry?: () => void }
  | { status: "ready"; narrative: PublishNarrativeView };

/** Whether the question holds its click: the sentence and its warnings come before it. */
export function narrativeHolds(read: PublishNarrativeRead): boolean {
  return read.status === "loading" || read.status === "failed";
}

/** The read for an answer already in hand, as the review of a held publish carries it. */
export function narrativeReadOf(parsed: ParsedPublishNarrative): PublishNarrativeRead {
  if (parsed.status === "absent") return { status: "none" };
  if (parsed.status === "malformed") return { status: "failed", reason: "malformed" };
  return { status: "ready", narrative: parsed.narrative };
}

/**
 * Reads the narrative of one revision while the question is open. `read` answers the asset as
 * the instance gives it, or nothing where the source has no such read.
 */
export function usePublishNarrative(
  key: readonly unknown[],
  read: ((signal: AbortSignal) => Promise<unknown>) | undefined
): PublishNarrativeRead {
  const { locale } = useTranslation();
  const query = useQuery({
    queryKey: ["publish-narrative", locale, ...key],
    queryFn: async ({ signal }): Promise<ParsedPublishNarrative> =>
      parsePublishNarrative(read ? await read(signal) : undefined),
    enabled: read !== undefined,
    staleTime: 0,
    retry: false
  });
  if (read === undefined) return { status: "none" };
  const retry = () => void query.refetch().catch(() => undefined);
  if (query.isError) return { status: "failed", reason: "read", retry };
  if (query.data === undefined) return { status: "loading" };
  const answer = narrativeReadOf(query.data);
  return answer.status === "failed" ? { ...answer, retry } : answer;
}

/** The sentence and its warnings, first in the question. */
function PublishNarrativeLead({ narrative }: { narrative: PublishNarrativeView }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-3" data-testid="publish-narrative">
      <p
        className="text-body text-foreground wrap-anywhere"
        data-testid="publish-narrative-summary"
      >
        {narrative.summary}
      </p>
      {narrative.warnings.length > 0 ? (
        <Banner
          tone="warning"
          role="note"
          title={t("publishNarrative.warnings")}
          data-testid="publish-narrative-warnings"
        >
          <ul className="grid gap-1">
            {narrative.warnings.map((warning) => (
              <li key={warning} className="wrap-anywhere">
                {warning}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </div>
  );
}

/** The lead for a read: a placeholder while it loads, the retry after it failed. */
export function PublishNarrativeReadLead({ read }: { read: PublishNarrativeRead }) {
  const { t } = useTranslation();
  if (read.status === "none") return null;
  if (read.status === "loading") {
    return (
      <div className="grid min-w-0 gap-1" data-testid="publish-narrative-loading">
        <span className="sr-only" role="status">
          {t("publishNarrative.loading")}
        </span>
        <SkeletonList rows={2} className="w-full" />
      </div>
    );
  }
  if (read.status === "failed") {
    return (
      <div className="grid justify-items-start gap-2" data-testid="publish-narrative-failed">
        <InlineError>
          {t(read.reason === "read" ? "publishNarrative.failed" : "publishNarrative.malformed")}
        </InlineError>
        {read.retry ? (
          <Button variant="outline" size="sm" onClick={read.retry}>
            {t("tryAgain")}
          </Button>
        ) : null}
      </div>
    );
  }
  return <PublishNarrativeLead narrative={read.narrative} />;
}

/** What the question listed before the sentence: folded under "Details". */
export function PublishDetails({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Disclosure data-testid="publish-details">
      <DisclosureTrigger>{t("publishNarrative.details")}</DisclosureTrigger>
      <DisclosureContent keepMounted data-testid="publish-details-content">
        <div className="grid min-w-0 gap-3 pt-2">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}
