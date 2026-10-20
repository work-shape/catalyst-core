import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { Badge, Disclosure, DisclosureContent, DisclosureTrigger } from "@work-shape/catalyst-ui";
import { RouteLink } from "../../studio/route-link";
import { AGENTS_BUILD_PATH } from "../../shared/build-route";
import { useTranslation } from "../../shared/i18n";
import { useApprovalRevisionHost } from "../approvals/approval-revision-host";

// A comment on an agent's answer in its reviewer's Inbox (LU-4): what the author wrote, a
// workflow's summary beside it where one exists, the agent and its revision, the date, the
// author, and the question and the answer where the author included them. Its one answer is
// "mark handled", with an optional note.

export interface FeedbackPreview {
  agent: { name: string; displayName?: string; revision?: number };
  text?: string;
  summary?: { text: string; category?: string };
  exchange?: { question: string; answer: string };
  /** Withdrawn by its author, or removed: the item has nothing left to show. */
  gone: boolean;
}

/** The comment of an item's preview, or nothing where the preview is not one. */
export function parseFeedbackPreview(preview: unknown): FeedbackPreview | undefined {
  if (!isRecord(preview) || !isRecord(preview.agent)) return undefined;
  const { agent } = preview;
  const name = agent.name;
  if (typeof name !== "string") return undefined;
  const summary = isRecord(preview.annotation) ? preview.annotation : undefined;
  const exchange = isRecord(preview.exchange) ? preview.exchange : undefined;
  return {
    agent: {
      name,
      ...(typeof agent.displayName === "string" ? { displayName: agent.displayName } : {}),
      ...(typeof agent.revision === "number" ? { revision: agent.revision } : {})
    },
    ...(typeof preview.text === "string" ? { text: preview.text } : {}),
    ...(summary && typeof summary.summary === "string"
      ? {
          summary: {
            text: summary.summary,
            ...(typeof summary.category === "string" ? { category: summary.category } : {})
          }
        }
      : {}),
    ...(exchange && typeof exchange.question === "string" && typeof exchange.answer === "string"
      ? { exchange: { question: exchange.question, answer: exchange.answer } }
      : {}),
    gone: preview.gone === true
  };
}

/** The agent's name as people read it. */
export function feedbackAgentLabel(preview: FeedbackPreview): string {
  return preview.agent.displayName ?? preview.agent.name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function FeedbackBody({ item }: { item: ApprovalRequestView }) {
  const { t } = useTranslation();
  const host = useApprovalRevisionHost();
  const feedback = parseFeedbackPreview(item.preview);
  if (!feedback) return null;
  if (feedback.gone) {
    return <p className="text-muted-foreground">{t("feedback.gone")}</p>;
  }
  // The head of the item says who wrote it and when; the revision is the agent's at the time.
  return (
    <div className="grid min-w-0 gap-4" data-testid="inbox-feedback">
      {feedback.agent.revision === undefined ? null : (
        <p className="text-caption text-muted-foreground">
          {t("feedback.revision", { revision: feedback.agent.revision })}
        </p>
      )}
      <blockquote className="min-w-0 border-l-2 pl-3 whitespace-pre-wrap break-words">
        {feedback.text}
      </blockquote>
      {feedback.summary ? (
        <div className="grid min-w-0 gap-1.5" data-testid="inbox-feedback-summary">
          <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            <span className="font-medium text-foreground">{t("feedback.summary")}</span>
            <Badge size="sm" tone="neutral">
              {t("feedback.machineWritten")}
            </Badge>
            {feedback.summary.category ? (
              <Badge size="sm" tone="info">
                {feedback.summary.category}
              </Badge>
            ) : null}
          </div>
          <p className="min-w-0 whitespace-pre-wrap break-words">{feedback.summary.text}</p>
        </div>
      ) : null}
      {feedback.exchange ? (
        <Disclosure variant="outline" data-testid="inbox-feedback-exchange">
          <DisclosureTrigger className="px-3">{t("feedback.exchange")}</DisclosureTrigger>
          <DisclosureContent className="grid gap-3 px-3 pt-3">
            <ExchangePart label={t("feedback.question")} text={feedback.exchange.question} />
            <ExchangePart label={t("feedback.answer")} text={feedback.exchange.answer} />
          </DisclosureContent>
        </Disclosure>
      ) : (
        <p className="text-caption text-muted-foreground">{t("feedback.noExchange")}</p>
      )}
      <div>
        <RouteLink
          route={{ kind: "build-asset", assetKind: AGENTS_BUILD_PATH, name: feedback.agent.name }}
          variant="link"
          className="px-0"
          onOpen={(route) => host?.openRoute?.(route)}
        >
          {t("feedback.openAgent")}
        </RouteLink>
      </div>
    </div>
  );
}

function ExchangePart({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-caption font-medium text-muted-foreground">{label}</span>
      <p className="min-w-0 whitespace-pre-wrap break-words">{text}</p>
    </div>
  );
}
