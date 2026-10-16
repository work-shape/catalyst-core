import { Sparkles } from "lucide-react";
import { useState } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import { Button, Dialog } from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { useTranslation } from "../../shared/i18n";
import { useAppsHost } from "./apps-host";
import { PageHeaderAction } from "./page-header-action";

/**
 * "Edit with the agent" in the head of an App, for a reader who may write it: it makes a
 * conversation about the App and opens it in the dock beside the App's draft, which stays the
 * page. A refusal is said in a dialog.
 */
export function AppEditWithAgentAction({ app }: { app: string }) {
  const { t } = useTranslation();
  const host = useAppsHost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editWithAgent = host?.editWithAgent;
  if (host === undefined || editWithAgent === undefined || !host.rights.write) {
    return null;
  }
  return (
    <>
      <PageHeaderAction
        label={t("apps.editWithAgent")}
        icon={<Sparkles aria-hidden="true" />}
        onClick={() => {
          if (busy) {
            return;
          }
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
        }}
      />
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
    </>
  );
}
