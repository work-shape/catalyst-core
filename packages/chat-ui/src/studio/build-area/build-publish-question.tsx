import { useRef, useState } from "react";
import { Button } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";

// What publishing a saved draft raises, read when the publish dialog opens: the question the
// page loaded may be stale after a save. A Knowledge Base with a synced source names who finds
// what in it, with which shared account (SRC-2).

/** The question as the dialog shows it. */
export type PublishQuestionRead =
  | { status: "none" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; lines: readonly string[] };

/** A hook: the question, read anew on each `ask`. Without `read` it asks nothing. */
export function usePublishQuestion(read: (() => Promise<readonly string[]>) | undefined): {
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
      (lines) => {
        if (asked.current === number) setQuestion({ status: "ready", lines });
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
  const { t } = useTranslation();
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
  return (
    <ul
      aria-label={t("build.publishRaises")}
      className="mt-3 grid gap-1 text-body text-foreground"
      data-build-publish-question="ready"
    >
      {question.lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
