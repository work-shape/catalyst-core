import { useState, type ReactNode } from "react";
import { ApiError, type Asset } from "@work-shape/catalyst-api-client";
import { Button, Dialog } from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useOfferDockPageChat } from "../../shared/dock-page-chat";
import { useTranslation } from "../../shared/i18n";
import { formatMomentShort } from "../../shared/locale-format";
import type { AppRights } from "./app-model";
import { useAppsHost } from "./apps-host";

/**
 * The conversation the page head's one "Chat" starts on an App's page, for a reader who may
 * write it by the `rights` on that App (`appRightsOn`), not the workspace's: the agent that
 * builds, about the App, in the dock beside its draft, which stays the page; a new one holds the
 * App's current draft with all its files (CHECKOUT-2). Without `app` the page offers none, and
 * "Chat" opens the plain chat. A refusal is said in a dialog, which the page draws outside its
 * head, so the answer stays readable whatever the head shows by the time it comes.
 */
export function useAppEditWithAgent(
  app: string | undefined,
  rights: Pick<AppRights, "write">,
  editors?: Asset["appEditors"]
): {
  dialog: ReactNode;
  editingLine: string | undefined;
} {
  const { t, locale } = useTranslation();
  const editingLine =
    rights.write && editors?.length
      ? editors
          .map((editor) =>
            t("apps.beingEdited", {
              name: editor.displayLabel,
              since: formatMomentShort(editor.since, locale)
            })
          )
          .join(" · ")
      : undefined;
  const host = useAppsHost();
  const [error, setError] = useState<string>();
  const editWithAgent = host?.editWithAgent;
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
  return {
    editingLine,
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
