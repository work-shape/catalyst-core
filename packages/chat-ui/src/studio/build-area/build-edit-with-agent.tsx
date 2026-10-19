import { Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError } from "@work-shape/catalyst-api-client";
import { Button, Dialog } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { HeadAgentAction } from "../head-agent-action";
import { instanceSentence } from "./build-refusals";

/**
 * "Edit with the agent" in the head of an asset page in Build: it opens the dock beside the
 * page with a conversation about the asset. Without `start` it is absent: the reader may not
 * change the asset, or the instance offers no agent that builds. A refusal is said in a dialog
 * drawn outside the head, so it stays readable whatever the head shows by then.
 */
export function useBuildEditWithAgent(start: (() => Promise<void>) | undefined): {
  action: ReactNode;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (start === undefined) {
    return { action: undefined, dialog: null };
  }
  return {
    action: (
      <HeadAgentAction
        action={{
          label: t("build.editWithAgent"),
          icon: <Sparkles aria-hidden="true" />,
          loading: busy,
          onSelect() {
            setBusy(true);
            start()
              .catch((failure: unknown) => {
                setError(
                  // An asset the reader may not read and one that is gone are refused alike.
                  failure instanceof ApiError && (failure.status === 403 || failure.status === 404)
                    ? t("build.editWithAgentRefused")
                    : (instanceSentence(failure) ?? t("build.editWithAgentFailed"))
                );
              })
              .finally(() => setBusy(false));
          }
        }}
      />
    ),
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
