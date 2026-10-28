import { MessageSquarePlus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import { Button, Dialog, type PageHeaderAction } from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useOfferDockPageChat } from "../../shared/dock-page-chat";
import { useTranslation } from "../../shared/i18n";
import type { AppRights } from "./app-model";
import { useAppsHost } from "./apps-host";

/**
 * The conversation the page head's "Chat" starts on an App's page, for a reader who may write
 * it by the `rights` on that App (`appRightsOn`), not the workspace's: a conversation about the
 * App in the dock beside its draft, which stays the page. Without `app` the page offers none.
 * Beside it, "Edit in chat" (`editInChat`, a head action for the same reader): a new
 * conversation with the agent that builds, which holds the App's current draft with all its
 * files (CHECKOUT-2). A refusal of either is said in a dialog, which the page draws outside its
 * head, so the answer stays readable whatever the head shows by the time it comes.
 */
export function useAppEditWithAgent(
  app: string | undefined,
  rights: Pick<AppRights, "write">
): { dialog: ReactNode; editInChat: PageHeaderAction | undefined } {
  const { t } = useTranslation();
  const host = useAppsHost();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const editWithAgent = host?.editWithAgent;
  const startInChat = host?.editInChat;
  const refused = (failure: unknown) => {
    setError(
      // An App the reader may not read and one that is gone are refused alike.
      failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
        ? t("apps.editWithAgentRefused")
        : (instanceSentence(failure, t) ?? t("apps.editWithAgentFailed"))
    );
  };
  const offered = app !== undefined && rights.write;
  useOfferDockPageChat(
    !offered || editWithAgent === undefined
      ? undefined
      : (options) => editWithAgent(app, options).catch(refused)
  );
  const editInChat =
    !offered || startInChat === undefined
      ? undefined
      : {
          label: t("apps.editInChat"),
          icon: <MessageSquarePlus aria-hidden="true" />,
          loading: starting,
          disabled: starting,
          onSelect: () => {
            setStarting(true);
            startInChat(app)
              .catch(refused)
              .finally(() => setStarting(false));
          }
        };
  return {
    editInChat,
    dialog: (
      <Dialog
        open={error !== undefined}
        title={t("apps.editWithAgentFailed")}
        onClose={() => setError(undefined)}
        footer={
          <Button variant="outline" onClick={() => setError(undefined)}>
            {t("apps.editWithAgentClose")}
          </Button>
        }
      >
        <p className="text-body">{error}</p>
      </Dialog>
    )
  };
}
