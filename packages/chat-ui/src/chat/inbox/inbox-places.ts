import {
  APP_ASSET_KIND,
  type ApprovalRequestView,
  type CollaborationWorkspaceWithRole,
  type PlatformContext
} from "@work-shape/catalyst-api-client";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { collaborationWorkspaceDisplayName } from "../../shared/collaboration-workspace/collaboration-workspace-name";
import type { TranslationKey } from "../../shared/i18n";
import { resolveAppRights } from "../../studio/apps/app-model";
import { resolveWorkflowRights } from "../../studio/workflows/workflow-model";
import type { InboxItemTarget, InboxPlaces } from "../approvals/approval-revision-host";
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
    route(target) {
      switch (target.kind) {
        case "app":
          return appsOpen && resolveAppRights(context, target.workspaceId).read
            ? { kind: "app", collaborationWorkspaceId: target.workspaceId, app: target.app }
            : undefined;
        case "app-edit":
          // The draft page is the page of who writes the App.
          return appsOpen && resolveAppRights(context, target.workspaceId).write
            ? { kind: "app-edit", collaborationWorkspaceId: target.workspaceId, app: target.app }
            : undefined;
        case "workflow": {
          if (!workflowsOpen) return undefined;
          // A Workflow the instance owns has no workspace of its own: it opens in the reader's
          // Personal Workspace, as a run notice's link does, and only rights on the instance
          // open it there. A right in that workspace is never lent to it.
          const at =
            target.workspaceId ?? workspaces.find((workspace) => workspace.kind === "personal")?.id;
          if (at === undefined) return undefined;
          const rights = resolveWorkflowRights(context, target.workspaceId);
          const opens = [rights.instance, rights.workspace?.rights].some(
            (on) => on !== undefined && (on.read || on.write || on.publish)
          );
          return opens
            ? { kind: "workflow", collaborationWorkspaceId: at, workflow: target.workflow }
            : undefined;
        }
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
  target: InboxItemTarget;
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
  if (!review) return [];
  if (review.kind === APP_ASSET_KIND) {
    // An App always has an owning workspace; a call that names none leads nowhere.
    if (!workspaceId) return [];
    const app = { workspaceId, app: review.name };
    return [
      { target: { kind: "app-edit", ...app }, label: "apps.openDraft" },
      ...(review.liveRevision === undefined
        ? []
        : [
            {
              target: { kind: "app", ...app },
              label: "inbox.noticeOpenApp"
            } satisfies InboxItemPlace
          ])
    ];
  }
  if (review.kind === WORKFLOW_ASSET_KIND) {
    // The held call names the Workflow's owning workspace; without one, the instance owns it.
    return [
      {
        target: {
          kind: "workflow",
          ...(workspaceId ? { workspaceId } : {}),
          workflow: review.name
        },
        label: "inbox.openWorkflow"
      }
    ];
  }
  return [];
}
