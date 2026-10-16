import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCopyItem,
  DropdownMenuTrigger,
  IconButton
} from "@work-shape/catalyst-ui";
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

/** The "…" of a head that offers nothing else: a menu with "Copy ID". */
export function CopyIdMenu({ id, label }: { id: string; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} variant="outline" size="sm">
          <MoreHorizontal aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <CopyIdItem id={id} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
