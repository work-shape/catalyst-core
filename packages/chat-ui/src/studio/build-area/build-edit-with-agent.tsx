import { useState, type ReactNode } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import { Button, Dialog } from "@work-shape/catalyst-ui";
import { useOfferDockPageChat } from "../../shared/dock-page-chat";
import { useTranslation } from "../../shared/i18n";
import { instanceSentence } from "./build-refusals";

/**
 * The conversation about an asset that the page head's "Chat" starts on an asset page in Build:
 * the dock beside the page with a conversation about the asset. Without `start` the page offers
 * none: the reader may not change the asset, or the instance offers no agent that builds, and
 * "Chat" opens the dock's last conversation instead. A refusal is said in a dialog drawn outside
 * the head, so it stays readable whatever the head shows by then.
 */
export function useBuildEditWithAgent(
  start: ((options: { fresh: boolean }) => Promise<void>) | undefined
): { dialog: ReactNode } {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  useOfferDockPageChat(
    start === undefined
      ? undefined
      : (options) =>
          start(options).catch((failure: unknown) => {
            setError(
              // An asset the reader may not read and one that is gone are refused alike.
              failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
                ? t("build.editWithAgentRefused")
                : (instanceSentence(failure, t) ?? t("build.editWithAgentFailed"))
            );
          })
  );
  return {
    dialog: (
      <Dialog
        open={error !== undefined}
        title={t("build.editWithAgentFailed")}
        onClose={() => setError(undefined)}
        footer={
          <Button variant="outline" onClick={() => setError(undefined)}>
            {t("build.editWithAgentClose")}
          </Button>
        }
      >
        <p className="text-body" data-build-edit-with-agent-refused="">
          {error}
        </p>
      </Dialog>
    )
  };
}
