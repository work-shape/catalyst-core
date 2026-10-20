import { Button, NotFound } from "@work-shape/catalyst-ui";
import { AreaFrame, useAreaTitleFocus } from "../../shared/area-frame";
import { useTranslation } from "../../shared/i18n";
import { apiErrorStatus } from "../../shared/workspace-utils";

/**
 * The thread read was refused: the instance answers the same for a conversation that was
 * deleted, that expired, that lies in a workspace the person does not reach, that is another
 * member's private one, or that never was, so the interface cannot tell them apart either.
 */
export function isConversationGone(error: unknown): boolean {
  const status = apiErrorStatus(error);
  return status === 403 || status === 404;
}

/**
 * The chat route of a conversation that is gone. The address stays as it was opened, so the
 * person sees what they asked for; the one step leads to a new chat.
 */
export function ConversationGone({ onNewChat }: { onNewChat(): void }) {
  const { t } = useTranslation();
  const areaRef = useAreaTitleFocus(true);
  return (
    <AreaFrame ref={areaRef} label={t("conversationGone")}>
      <NotFound
        data-conversation-gone=""
        action={<Button onClick={onNewChat}>{t("nav.newChat")}</Button>}
      >
        {t("conversationGone")}
      </NotFound>
    </AreaFrame>
  );
}
