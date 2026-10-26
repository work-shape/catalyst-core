import { useState, type ReactNode } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import { Button, Dialog } from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useOfferDockPageChat } from "../../shared/dock-page-chat";
import { useTranslation } from "../../shared/i18n";
import type { AppRights } from "./app-model";
import { useAppsHost } from "./apps-host";

/**
 * The conversation the page head's "Chat" starts on an App's page, for a reader who may write
 * it by the `rights` on that App (`appRightsOn`), not the workspace's: a conversation about the
 * App in the dock beside its draft, which stays the page. Without `app` the page offers none. A
 * refusal is said in a dialog, which the page draws outside its head, so the answer stays
 * readable whatever the head shows by the time it comes.
 */
export function useAppEditWithAgent(
  app: string | undefined,
  rights: Pick<AppRights, "write">
): { dialog: ReactNode } {
  const { t } = useTranslation();
  const host = useAppsHost();
  const [error, setError] = useState<string>();
  const editWithAgent = host?.editWithAgent;
  useOfferDockPageChat(
    app === undefined || editWithAgent === undefined || !rights.write
      ? undefined
      : (options) =>
          editWithAgent(app, options).catch((failure: unknown) => {
            setError(
              // An App the reader may not read and one that is gone are refused alike.
              failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
                ? t("apps.editWithAgentRefused")
                : (instanceSentence(failure, t) ?? t("apps.editWithAgentFailed"))
            );
          })
  );
  return {
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
