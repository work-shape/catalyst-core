import { Hourglass } from "lucide-react";
import { useEffect } from "react";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { Button, EmptyState } from "@work-shape/catalyst-ui";
import { useApprovalRevisionHost } from "../../chat/approvals/approval-revision-host";
import { parseOperationCallPreview } from "../../chat/approvals/operation-call-preview";
import { useInboxListQuery } from "../../chat/inbox/inbox-api";
import { APPROVAL_AUTH_SCOPE } from "../../shared/api/approval-request-api";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { RouteLink } from "../route-link";

// A call of a frame that waits for another person's approval. The frame is told only that it
// waits; the host says so over the frame and leads to the request in the Inbox. The notice
// goes when the request is decided or ends, when the frame shows another document, and when
// the person closes it.

/** A call that waits, under its run, in the frame session it was made from. */
export interface FrameWait {
  session: string;
  runId: string;
}

/** The request of the person's own requests that holds the call of this run. */
function requestOfRun(
  requests: readonly ApprovalRequestView[] | undefined,
  runId: string
): ApprovalRequestView | undefined {
  return requests?.find((request) => parseOperationCallPreview(request.preview)?.runId === runId);
}

/** The wait is over once its request is no longer pending: approved, declined or ended. */
function frameWaitEnded(request: Pick<ApprovalRequestView, "status"> | undefined): boolean {
  return request !== undefined && request.status !== "pending";
}

/** Over the frame while a call of it waits: follows the request until it is decided. */
export function FrameApprovalWait({ runId, onEnd }: { runId: string; onEnd(): void }) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const host = useApprovalRevisionHost();
  const mine = useInboxListQuery({
    apiBaseUrl,
    authScope: APPROVAL_AUTH_SCOPE,
    client,
    tab: "mine",
    enabled: true
  });
  const request = requestOfRun(mine.data, runId);
  const ended = frameWaitEnded(request);
  useEffect(() => {
    if (ended) onEnd();
  }, [ended, onEnd]);
  return ended ? null : (
    <FrameApprovalWaitView
      itemId={request?.id}
      onOpen={(route) => host?.openRoute?.(route)}
      onClose={onEnd}
    />
  );
}

/** The notice over the frame: what waits, the way to its request, and Close. */
function FrameApprovalWaitView({
  itemId,
  onOpen,
  onClose
}: {
  /** The request in the Inbox, once the person's list names it. Until then the Inbox. */
  itemId: string | undefined;
  onOpen(route: WorkspaceRoute): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const route: WorkspaceRoute =
    itemId === undefined ? { kind: "inbox" } : { kind: "inbox-item", itemId };
  return (
    <div
      role="status"
      data-testid="frame-approval-wait"
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/85 p-4"
    >
      <EmptyState
        icon={<Hourglass aria-hidden="true" />}
        action={
          <span className="flex flex-wrap justify-center gap-2">
            <RouteLink route={route} variant="primary" onOpen={onOpen}>
              {t("pages.callWaitsOpen")}
            </RouteLink>
            <Button variant="outline" size="sm" onClick={onClose}>
              {t("close")}
            </Button>
          </span>
        }
      >
        {t("pages.callWaits")}
      </EmptyState>
    </div>
  );
}
