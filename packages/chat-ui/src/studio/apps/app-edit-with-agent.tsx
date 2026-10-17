import { Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import { Button, Dialog, type PageHeaderAction } from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useTranslation } from "../../shared/i18n";
import { useAppsHost } from "./apps-host";

/**
 * "Edit with the agent" in the head of an App, for a reader who may write it: it makes a
 * conversation about the App and opens it in the dock beside the App's draft, which stays the
 * page. A refusal is said in a dialog, which the page draws outside its head: the action may
 * stand in the head's "…" menu, which is gone by the time the answer comes.
 */
export function useAppEditWithAgent(app: string | undefined): {
  action: PageHeaderAction | undefined;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const host = useAppsHost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editWithAgent = host?.editWithAgent;
  if (
    app === undefined ||
    host === undefined ||
    editWithAgent === undefined ||
    !host.rights.write
  ) {
    return { action: undefined, dialog: null };
  }
  return {
    action: {
      label: t("apps.editWithAgent"),
      icon: <Sparkles aria-hidden="true" />,
      loading: busy,
      onSelect() {
        setBusy(true);
        editWithAgent(app)
          .catch((failure: unknown) => {
            setError(
              // An App the reader may not read and one that is gone are refused alike.
              failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
                ? t("apps.editWithAgentRefused")
                : (instanceSentence(failure) ?? t("apps.editWithAgentFailed"))
            );
          })
          .finally(() => setBusy(false));
      }
    },
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
