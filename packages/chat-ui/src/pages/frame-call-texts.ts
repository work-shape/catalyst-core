import { useMemo } from "react";
import { useTranslation } from "../i18n";
import type { FrameCallTexts } from "./frame-calls";

/**
 * The sentences the interface words for a call of a frame, in the language of whoever looks
 * at it. The platform's own, so no App words a refusal of the platform.
 */
export function useFrameCallTexts(): FrameCallTexts {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      connectionUseDenied: (name, frame) =>
        name !== undefined
          ? t("pages.connectionUseDenied", { name })
          : frame === "page"
            ? t("pages.connectionUseDeniedUnnamedPage")
            : t("pages.connectionUseDeniedUnnamed")
    }),
    [t]
  );
}
