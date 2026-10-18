import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  FormNotice
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { useOptionalSettingsPage } from "../../shared/settings-page-context";

/**
 * The instance's own sentence about a refusal, collapsed under Technical details, for an
 * administrator of the instance: it can name release config, which only they can pass on or
 * change. Nobody else is shown it.
 */
export function RefusalDetail({ detail }: { detail: string | undefined }) {
  const { t } = useTranslation();
  const roles = useOptionalSettingsPage()?.user.roles ?? [];
  const administers = roles.includes("admin") || roles.includes("superadmin");
  return detail !== undefined && administers ? (
    <Disclosure data-refusal-detail="">
      <DisclosureTrigger>{t("connectionCreate.details")}</DisclosureTrigger>
      <DisclosureContent>{detail}</DisclosureContent>
    </Disclosure>
  ) : null;
}

/** A refused change in the reader's words, with the instance's sentence for an administrator. */
export function RefusalNotice({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="grid gap-1">
      <FormNotice tone="error">{message}</FormNotice>
      <RefusalDetail detail={detail} />
    </div>
  );
}
