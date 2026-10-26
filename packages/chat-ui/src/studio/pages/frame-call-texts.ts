import { useMemo } from "react";
import { refusalAskingInstanceAdmin } from "../../admin/settings/ask-instance-admin";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useWorkspaceMeQuery } from "../../shared/api/workspace-queries";
import { useTranslation } from "../../shared/i18n";
import { tellRefusal } from "../../shared/i18n/refusals";
import type { FrameCallTexts } from "./frame-calls";

/**
 * The sentences the interface words for a call of a frame, in the language of whoever looks
 * at it. The platform's own, so no App words a refusal of the platform. A missing right ends
 * with whom to ask, never with a page the person cannot open. A refusal the refusal table
 * knows is told in its sentence (REFUSE-1); the code the App reads stays the instance's.
 */
export function useFrameCallTexts(): FrameCallTexts {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const instanceAdminName = useWorkspaceMeQuery({ apiBaseUrl, client }).data?.instanceAdminName;
  return useMemo(
    () => ({
      connectionUseDenied: (name, frame) =>
        refusalAskingInstanceAdmin(
          name !== undefined
            ? t("pages.connectionUseDenied", { name })
            : frame === "page"
              ? t("pages.connectionUseDeniedUnnamedPage")
              : t("pages.connectionUseDeniedUnnamed"),
          t,
          instanceAdminName
        ),
      refusal: (details) => tellRefusal(details, t)?.message
    }),
    [t, instanceAdminName]
  );
}
