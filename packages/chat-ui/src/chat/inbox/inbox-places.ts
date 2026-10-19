import {
  APP_ASSET_KIND,
  type ApprovalRequestView,
  type CollaborationWorkspaceWithRole,
  type PlatformContext
} from "@work-shape/catalyst-api-client";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { collaborationWorkspaceDisplayName } from "../../shared/collaboration-workspace/collaboration-workspace-name";
import type { TranslationKey } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { resolveAppRights } from "../../studio/apps/app-model";
import { resolveWorkflowRights } from "../../studio/workflows/workflow-model";
import type { InboxPlaces } from "../approvals/approval-revision-host";
import { parseOperationCallPreview } from "../approvals/operation-call-preview";
import { parseNoticePreview } from "./notice-item";

/** The Inbox's places for this reader, from what the workspace has already read. */
export function inboxPlaces(input: {
  context: PlatformContext | undefined;
  workspaces: readonly Pick<CollaborationWorkspaceWithRole, "id" | "kind" | "name" | "emoji">[];
  /** The reader's label, which names their Personal Workspace. */
  ownerLabel: string | undefined;
  appsOpen: boolean;
  workflowsOpen: boolean;
}): InboxPlaces {
  const { context, workspaces, ownerLabel, appsOpen, workflowsOpen } = input;
  return {
    workspace(workspaceId, t) {
      const found = workspaces.find((workspace) => workspace.id === workspaceId);
      return found
        ? { name: collaborationWorkspaceDisplayName(found, ownerLabel, t), emoji: found.emoji }
        : undefined;
    },
    opens(route) {
      switch (route.kind) {
        case "app":
          return appsOpen && resolveAppRights(context, route.collaborationWorkspaceId).read;
        case "app-edit":
          // The draft page is the page of who writes the App.
          return appsOpen && resolveAppRights(context, route.collaborationWorkspaceId).write;
        case "workflow": {
          if (!workflowsOpen) return false;
          const rights = resolveWorkflowRights(context, route.collaborationWorkspaceId);
          return [rights.instance, rights.workspace?.rights].some(
            (on) => on !== undefined && (on.read || on.write || on.publish)
          );
        }
        default:
          return false;
      }
    }
  };
}

/** The workspace an item comes from, where it names one. */
export function inboxItemWorkspaceId(
  item: Pick<ApprovalRequestView, "preview">
): string | undefined {
  return (
    parseOperationCallPreview(item.preview)?.workspaceId ??
    parseNoticePreview(item.preview)?.link?.workspaceId
  );
}

/** A place an item leads to, with the words of its link. */
interface InboxItemPlace {
  route: WorkspaceRoute;
  label: TranslationKey;
}

/**
 * Where a publish under review can be read in full, best first: an App's draft, then the live
 * App; a Workflow's page. The reader is offered the first they may open.
 */
export function inboxItemPlaces(
  item: Pick<ApprovalRequestView, "preview">
): readonly InboxItemPlace[] {
  const call = parseOperationCallPreview(item.preview);
  const review = call?.review;
  const workspaceId = call?.workspaceId;
  if (!review || !workspaceId) return [];
  const where = { collaborationWorkspaceId: workspaceId };
  if (review.kind === APP_ASSET_KIND) {
    return [
      { route: { kind: "app-edit", ...where, app: review.name }, label: "apps.openDraft" },
      ...(review.liveRevision === undefined
        ? []
        : [
            {
              route: { kind: "app", ...where, app: review.name },
              label: "inbox.noticeOpenApp"
            } satisfies InboxItemPlace
          ])
    ];
  }
  if (review.kind === WORKFLOW_ASSET_KIND) {
    return [
      { route: { kind: "workflow", ...where, workflow: review.name }, label: "inbox.openWorkflow" }
    ];
  }
  return [];
}
