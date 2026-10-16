import { Button, NotFound } from "@work-shape/catalyst-ui";
import { AreaFrame, useAreaTitleFocus } from "../../shared/area-frame";
import { useTranslation } from "../../shared/i18n";

/**
 * The page of an address no route resolves. The address stays as it was typed, so a person sees
 * what they asked for; the one step leads to the chat.
 */
export function RouteNotFound({ onOpenChat }: { onOpenChat(): void }) {
  const { t } = useTranslation();
  const areaRef = useAreaTitleFocus(true);
  return (
    <AreaFrame ref={areaRef} label={t("nav.notFound")}>
      <NotFound action={<Button onClick={onOpenChat}>{t("nav.toChat")}</Button>}>
        {t("nav.notFound")}
      </NotFound>
    </AreaFrame>
  );
}
