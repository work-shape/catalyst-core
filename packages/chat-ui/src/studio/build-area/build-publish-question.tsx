import { useRef, useState } from "react";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { Button } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { formatEmbeddingCostRange } from "./knowledge-cost";

// What publishing a saved draft raises, read when the publish dialog opens: the question the
// page loaded may be stale after a save. A Knowledge Base with a synced source names who finds
// what in it, with which shared account (SRC-2).

/**
 * What publishing raises, and for a Knowledge Base that processes or embeds again, the
 * confirmation of the count and cost its lines state, which the publish passes on.
 */
export interface PublishQuestionAnswer {
  lines: readonly string[];
  confirmation?: string;
  /**
   * What the publish processes again, as the fields of the sentence at index `line` of
   * `lines`, which the dialog words in the reader's language in its place.
   */
  processing?: PublishProcessing;
  /**
   * The widening check (DS-13c): its lines are among `lines`; where it fails, Publish sends the
   * confirmation, offered only to who may give it.
   */
  handover?: { holds: boolean; confirmation?: string };
}

/** The count and cost of the contents a Knowledge Base's publish processes again. */
export interface PublishProcessing {
  count: number;
  line: number;
  cost:
    | { kind: "none" }
    | { kind: "estimate"; min: number; max: number; currency: string }
    | { kind: "unavailable" };
}

/** The question as the dialog shows it. */
export type PublishQuestionRead =
  | { status: "none" }
  | { status: "loading" }
  | { status: "failed" }
  | ({ status: "ready" } & PublishQuestionAnswer);

/** A hook: the question, read anew on each `ask`. Without `read` it asks nothing. */
export function usePublishQuestion(read: (() => Promise<PublishQuestionAnswer>) | undefined): {
  question: PublishQuestionRead;
  ask(): void;
} {
  const [question, setQuestion] = useState<PublishQuestionRead>({ status: "none" });
  // Only the last ask answers: a slow earlier read never replaces a newer one.
  const asked = useRef(0);
  const ask = () => {
    if (read === undefined) return;
    const number = ++asked.current;
    setQuestion({ status: "loading" });
    read().then(
      (answer) => {
        if (asked.current === number) setQuestion({ status: "ready", ...answer });
      },
      () => {
        if (asked.current === number) setQuestion({ status: "failed" });
      }
    );
  };
  return { question, ask };
}

/** Whether the publish waits for the question: while it is read, or after its read failed. */
export function publishQuestionHolds(question: PublishQuestionRead): boolean {
  return question.status === "loading" || question.status === "failed";
}

/** The lines of the question under the publish dialog's description. */
export function PublishQuestionLines({
  question,
  onRetry
}: {
  question: PublishQuestionRead;
  onRetry(): void;
}) {
  const { locale, t } = useTranslation();
  if (question.status === "loading") {
    return (
      <p className="mt-3" data-build-publish-question="loading">
        {t("build.publishQuestionLoading")}
      </p>
    );
  }
  if (question.status === "failed") {
    return (
      <div className="mt-3 grid justify-items-start gap-2" data-build-publish-question="failed">
        <p>{t("build.publishQuestionFailed")}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("build.publishQuestionRetry")}
        </Button>
      </div>
    );
  }
  if (question.status !== "ready" || question.lines.length === 0) return null;
  const { processing } = question;
  const lines = question.lines.map((line, index) =>
    processing && processing.line === index ? processingSentence(processing, t, locale) : line
  );
  return (
    <ul
      aria-label={t("build.publishRaises")}
      className="mt-3 grid gap-1 text-body text-foreground"
      data-build-publish-question="ready"
    >
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** What a publish processes again and what that costs, in the reader's words. */
function processingSentence(
  { count, cost }: PublishProcessing,
  t: ReturnType<typeof useTranslation>["t"],
  locale: LocaleCode
): string {
  const read = t(count === 1 ? "build.publishProcessingOne" : "build.publishProcessingOther", {
    count: new Intl.NumberFormat(locale).format(count)
  });
  switch (cost.kind) {
    case "none":
      return `${read} ${t("build.publishProcessingFree")}`;
    case "estimate":
      return `${read} ${t(
        "build.publishProcessingEstimate",
        formatEmbeddingCostRange(cost.min, cost.max, cost.currency, locale)
      )}`;
    case "unavailable":
      return `${read} ${t("build.publishProcessingNoPrice")}`;
  }
}
