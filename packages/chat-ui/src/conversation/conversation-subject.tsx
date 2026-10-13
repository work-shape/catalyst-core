import { AppWindow, FileText, Workflow } from "lucide-react";
import { APP_ASSET_KIND } from "@vivd-catalyst/api-client";
import { WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { Banner, Button, TextLink } from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../i18n";
import type { WorkspaceRoute } from "../routes";
import { routeLink } from "../workflows/workflows-frame";

/** The asset a conversation is about, as the conversation carries it. */
export interface ConversationSubjectView {
  kind: string;
  name: string;
}

/** The page an asset of a kind leads back to, where the kind has one. */
function subjectRoute(
  subject: ConversationSubjectView,
  workspaceId: string | undefined
): WorkspaceRoute | undefined {
  if (workspaceId === undefined) {
    return undefined;
  }
  if (subject.kind === WORKFLOW_ASSET_KIND) {
    return { kind: "workflow", collaborationWorkspaceId: workspaceId, workflow: subject.name };
  }
  return subject.kind === APP_ASSET_KIND
    ? { kind: "app-edit", collaborationWorkspaceId: workspaceId, app: subject.name }
    : undefined;
}

const SUBJECT_LEADS: Readonly<Record<string, TranslationKey>> = {
  [WORKFLOW_ASSET_KIND]: "conversationSubjectWorkflow",
  [APP_ASSET_KIND]: "conversationSubjectApp"
};

function SubjectIcon({ kind }: { kind: string }) {
  if (kind === WORKFLOW_ASSET_KIND) {
    return <Workflow aria-hidden="true" />;
  }
  if (kind === APP_ASSET_KIND) {
    return <AppWindow aria-hidden="true" />;
  }
  return <FileText aria-hidden="true" />;
}

/**
 * Says over the composer what the open conversation is about, from its first empty moment on:
 * a conversation opened from the page of a Workflow looks like any new one without it. The
 * name of the asset leads back to its page, and where the asset is not shown beside the
 * conversation, one button shows it there again.
 */
export function ConversationSubjectLine({
  subject,
  title,
  workspaceId,
  onOpenRoute,
  onShow
}: {
  subject: ConversationSubjectView;
  /** The name people read for the asset. */
  title: string;
  workspaceId: string | undefined;
  onOpenRoute(route: WorkspaceRoute): void;
  /** Shows the asset beside the conversation. Absent while it is shown there. */
  onShow?: () => void;
}) {
  const { t } = useTranslation();
  const route = subjectRoute(subject, workspaceId);
  const lead = SUBJECT_LEADS[subject.kind];
  return (
    <Banner
      layout="line"
      icon={<SubjectIcon kind={subject.kind} />}
      className="mb-2 px-1"
      data-testid="conversation-subject"
      data-subject-kind={subject.kind}
      action={
        onShow === undefined ? undefined : (
          <Button variant="ghost" size="sm" onClick={onShow}>
            {t("conversationSubjectShow")}
          </Button>
        )
      }
    >
      {route === undefined || lead === undefined ? (
        t("conversationSubjectOther", { name: title })
      ) : (
        <>
          {t(lead)} <TextLink {...routeLink(route, onOpenRoute)}>{title}</TextLink>
        </>
      )}
    </Banner>
  );
}
