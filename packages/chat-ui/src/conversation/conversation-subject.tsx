import { Workflow } from "lucide-react";
import { WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { Banner, TextLink } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { WorkspaceRoute } from "../routes";
import { useWorkflowNames } from "../workflows/workflow-data";
import { routeLink } from "../workflows/workflows-frame";

/** The asset a conversation is about, as the conversation carries it. */
export interface ConversationSubjectView {
  kind: string;
  name: string;
}

/**
 * Says over the composer what the open conversation is about, from its first empty moment on:
 * a conversation opened from the page of a Workflow looks like any new one without it. The
 * name of a Workflow leads back to its page.
 */
export function ConversationSubjectLine({
  subject,
  workspaceId,
  onOpenRoute
}: {
  subject: ConversationSubjectView;
  workspaceId: string | undefined;
  onOpenRoute(route: WorkspaceRoute): void;
}) {
  const { t } = useTranslation();
  const isWorkflow = subject.kind === WORKFLOW_ASSET_KIND;
  const [title] = useWorkflowNames(
    isWorkflow ? workspaceId : undefined,
    isWorkflow ? [subject.name] : []
  );
  const route: WorkspaceRoute | undefined =
    isWorkflow && workspaceId !== undefined
      ? { kind: "workflow", collaborationWorkspaceId: workspaceId, workflow: subject.name }
      : undefined;
  return (
    <Banner
      layout="line"
      icon={<Workflow aria-hidden="true" />}
      className="mb-2 px-1"
      data-testid="conversation-subject"
      data-subject-kind={subject.kind}
    >
      {route === undefined ? (
        t("conversationSubjectOther", { name: subject.name })
      ) : (
        <>
          {t("conversationSubjectWorkflow")}{" "}
          <TextLink {...routeLink(route, onOpenRoute)}>{title ?? subject.name}</TextLink>
        </>
      )}
    </Banner>
  );
}
