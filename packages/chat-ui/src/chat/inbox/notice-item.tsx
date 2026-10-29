import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { Button } from "@work-shape/catalyst-ui";
import { RouteLink } from "../../studio/route-link";
import { useTranslation } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { useApprovalRevisionHost } from "../approvals/approval-revision-host";
import { ResultFeedback } from "../feedback/result-feedback";
import type { InboxItemActions } from "./inbox-item-actions";

// A notice in its reader's Inbox: a title, one paragraph and where it leads, such as the run
// it is about or an App. Its one answer is "mark handled".

type NoticeLink =
  | { kind: "workflow_run"; workspaceId: string; workflowId: string; runId: string }
  | { kind: "app"; workspaceId: string; app: string };

export interface NoticePreview {
  title: string;
  text: string;
  link?: NoticeLink;
}

/** The notice of an item's preview, or nothing where the preview is not one. */
export function parseNoticePreview(preview: unknown): NoticePreview | undefined {
  if (!isRecord(preview) || typeof preview.title !== "string" || typeof preview.text !== "string") {
    return undefined;
  }
  const link = parseLink(preview.link);
  return { title: preview.title, text: preview.text, ...(link ? { link } : {}) };
}

function parseLink(value: unknown): NoticeLink | undefined {
  if (!isRecord(value) || typeof value.workspaceId !== "string") return undefined;
  const { workspaceId } = value;
  if (value.kind === "app" && typeof value.app === "string") {
    return { kind: "app", workspaceId, app: value.app };
  }
  if (
    value.kind === "workflow_run" &&
    typeof value.workflowId === "string" &&
    typeof value.runId === "string"
  ) {
    return { kind: "workflow_run", workspaceId, workflowId: value.workflowId, runId: value.runId };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The place of the workspace a notice links to. */
function noticeRoute(link: NoticeLink): WorkspaceRoute {
  return link.kind === "app"
    ? { kind: "app", collaborationWorkspaceId: link.workspaceId, app: link.app }
    : {
        kind: "workflow-run",
        collaborationWorkspaceId: link.workspaceId,
        workflow: link.workflowId,
        run: link.runId
      };
}

export function NoticeBody({ item }: { item: ApprovalRequestView }) {
  const { t } = useTranslation();
  const host = useApprovalRevisionHost();
  const notice = parseNoticePreview(item.preview);
  if (!notice) {
    return null;
  }
  return (
    <div className="grid min-w-0 gap-3" data-testid="inbox-notice">
      <p className="min-w-0 whitespace-pre-wrap break-words">{notice.text}</p>
      {notice.link ? (
        <div>
          <RouteLink
            route={noticeRoute(notice.link)}
            variant="link"
            className="px-0"
            onOpen={(route) => host?.openRoute?.(route)}
          >
            {t(notice.link.kind === "app" ? "inbox.noticeOpenApp" : "inbox.noticeOpenRun")}
          </RouteLink>
        </div>
      ) : null}
      {/* The reader of a run's notice may tell its builders about the result (LU-6). */}
      {notice.link?.kind === "workflow_run" && host?.resultFeedback === true ? (
        <ResultFeedback item={item} />
      ) : null}
    </div>
  );
}

/** A notice asks nothing of its reader: they mark it handled, with no comment. */
export function NoticeFoot({ actions }: { item: ApprovalRequestView; actions: InboxItemActions }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="primary"
        className="ml-auto"
        disabled={actions.pending}
        data-decision="approve"
        onClick={() => actions.decide({ decision: "approve" })}
      >
        {t("inbox.noticeMarkHandled")}
      </Button>
    </div>
  );
}
