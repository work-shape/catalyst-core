import { DropdownMenuCopyItem } from "@work-shape/catalyst-ui";
import { useTranslation } from "../shared/i18n";

/**
 * "Copy ID" in the "…" menu of an asset's head: the one place its technical id is offered,
 * for the CLI and the API. The head itself names the asset and says what it does.
 */
export function CopyIdItem({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <DropdownMenuCopyItem value={id} copiedLabel={t("idCopied")}>
      {t("copyId")}
    </DropdownMenuCopyItem>
  );
}
