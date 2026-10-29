import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { FEEDBACK_ASSET_KINDS, type FeedbackAssetKind } from "@work-shape/catalyst-core";
import { Badge, Disclosure, DisclosureContent, DisclosureTrigger } from "@work-shape/catalyst-ui";
import { RouteLink } from "../../studio/route-link";
import { AGENTS_BUILD_PATH } from "../../shared/build-route";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { useApprovalRevisionHost, type InboxPlaces } from "../approvals/approval-revision-host";

// A comment in its reviewer's Inbox: on an agent's answer (LU-4), on an App or on the result of
// a Workflow run (LU-6). What the author wrote, a workflow's summary beside it where one exists,
// what it is about and its revision, the date, the author, and for an answer the question and
// the answer where the author included them. Its one answer is "mark handled", with an
// optional note.

export interface FeedbackPreview {
  /** The agent, App or Workflow the comment is about. */
  about: { kind: FeedbackAssetKind; name: string; displayName?: string; revision?: number };
  /** The workspace the asset or the comment belongs to, where there is one. */
  workspaceId?: string;
  /** The run whose result a comment on a Workflow is about. */
  workflowRunId?: string;
  text?: string;
  summary?: { text: string; category?: string };
  exchange?: { question: string; answer: string };
  /** Withdrawn by its author, or removed: the item has nothing left to show. */
  gone: boolean;
}

/**
 * What a comment is about. An item of LU-4 names only its agent; a later one names what it is
 * about in `about`.
 */
function parseAbout(preview: Record<string, unknown>) {
  const about = isRecord(preview.about)
    ? preview.about
    : isRecord(preview.agent)
      ? { ...preview.agent, kind: "agent" }
      : undefined;
  if (!about || typeof about.name !== "string" || typeof about.kind !== "string") return undefined;
  const kind = FEEDBACK_ASSET_KINDS.find((known) => known === about.kind);
  if (!kind) return undefined;
  return {
    about: {
      kind,
      name: about.name,
      ...(typeof about.displayName === "string" ? { displayName: about.displayName } : {}),
      ...(typeof about.revision === "number" ? { revision: about.revision } : {})
    },
    workspaceId:
      typeof about.workspaceId === "string"
        ? about.workspaceId
        : typeof preview.workspaceId === "string"
          ? preview.workspaceId
          : undefined
  };
}

/** The comment of an item's preview, or nothing where the preview is not one. */
export function parseFeedbackPreview(preview: unknown): FeedbackPreview | undefined {
  if (!isRecord(preview)) return undefined;
  const parsed = parseAbout(preview);
  if (!parsed) return undefined;
  const summary = isRecord(preview.annotation) ? preview.annotation : undefined;
  const exchange = isRecord(preview.exchange) ? preview.exchange : undefined;
  return {
    about: parsed.about,
    ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
    ...(typeof preview.workflowRunId === "string" ? { workflowRunId: preview.workflowRunId } : {}),
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

/** The name of what the comment is about, as people read it. */
export function feedbackAboutLabel(preview: FeedbackPreview): string {
  return preview.about.displayName ?? preview.about.name;
}

/** The heading of the item: which kind of thing the comment is about. */
export function feedbackHeadingKey(preview: FeedbackPreview): TranslationKey {
  return preview.about.kind === "app"
    ? "feedback.reviewHeadingApp"
    : preview.about.kind === "workflow"
      ? "feedback.reviewHeadingWorkflow"
      : "feedback.reviewHeading";
}

/**
 * Where the reviewer opens what the comment is about, and the words of the link. In a workspace
 * the Inbox's places decide, so no link ends on a page the reviewer may not read; an App or a
 * Workflow the reviewer cannot open there gets none.
 */
function aboutLink(
  preview: FeedbackPreview,
  places: InboxPlaces | undefined
): { route: WorkspaceRoute; label: TranslationKey } | undefined {
  const { about, workspaceId } = preview;
  if (about.kind === "agent") {
    return {
      route: { kind: "build-asset", assetKind: AGENTS_BUILD_PATH, name: about.name },
      label: "feedback.openAgent"
    };
  }
  if (about.kind === "app") {
    if (!workspaceId) return undefined;
    const route: WorkspaceRoute | undefined = places
      ? places.route({ kind: "app", workspaceId, app: about.name })
      : { kind: "app", collaborationWorkspaceId: workspaceId, app: about.name };
    return route ? { route, label: "feedback.openApp" } : undefined;
  }
  const run = preview.workflowRunId;
  if (!run) return undefined;
  // A Workflow the instance owns opens in the reviewer's own workspace.
  const workflow = places
    ? places.route({
        kind: "workflow",
        ...(workspaceId ? { workspaceId } : {}),
        workflow: about.name
      })
    : workspaceId
      ? { kind: "workflow" as const, collaborationWorkspaceId: workspaceId, workflow: about.name }
      : undefined;
  return workflow?.kind === "workflow"
    ? {
        route: {
          kind: "workflow-run",
          collaborationWorkspaceId: workflow.collaborationWorkspaceId,
          workflow: about.name,
          run
        },
        label: "feedback.openRun"
      }
    : undefined;
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
  // The head of the item says who wrote it and when; the revision is the asset's at the time.
  const link = aboutLink(feedback, host?.places);
  return (
    <div className="grid min-w-0 gap-4" data-testid="inbox-feedback">
      {feedback.about.revision === undefined ? null : (
        <p className="text-caption text-muted-foreground">
          {t("feedback.revision", { revision: feedback.about.revision })}
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
      ) : feedback.about.kind === "agent" ? (
        <p className="text-caption text-muted-foreground">{t("feedback.noExchange")}</p>
      ) : null}
      {link ? (
        <div>
          <RouteLink
            route={link.route}
            variant="link"
            className="px-0"
            onOpen={(route) => host?.openRoute?.(route)}
          >
            {t(link.label)}
          </RouteLink>
        </div>
      ) : null}
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
