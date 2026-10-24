import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  FormNotice
} from "@work-shape/catalyst-ui";
import { usePlatformContextQuery } from "../../shared/api/workspace-queries";
import { canViewSystem } from "../../shared/governance";
import { useTranslation } from "../../shared/i18n";
import {
  useOptionalSettingsPage,
  type SettingsPageContextValue
} from "../../shared/settings-page-context";

/**
 * The instance's own sentence about a refusal, collapsed under Technical details, for who sees
 * how the instance runs (`system.view`, RIGHTS-1e): it can name release config, which only they
 * can pass on or change. Nobody else is shown it.
 */
export function RefusalDetail({ detail }: { detail: string | undefined }) {
  const page = useOptionalSettingsPage();
  return detail !== undefined && page !== undefined ? (
    <SystemRefusalDetail detail={detail} page={page} />
  ) : null;
}

function SystemRefusalDetail({
  detail,
  page
}: {
  detail: string;
  page: Pick<SettingsPageContextValue, "apiBaseUrl" | "authScope" | "client">;
}) {
  const { t } = useTranslation();
  const platform = usePlatformContextQuery({
    apiBaseUrl: page.apiBaseUrl,
    authScope: page.authScope,
    client: page.client,
    enabled: true
  }).data;
  return canViewSystem(platform) ? (
    <Disclosure data-refusal-detail="">
      <DisclosureTrigger>{t("connectionCreate.details")}</DisclosureTrigger>
      <DisclosureContent>{detail}</DisclosureContent>
    </Disclosure>
  ) : null;
}

/** A refused change in the reader's words, with the instance's sentence for who runs it. */
export function RefusalNotice({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="grid gap-1">
      <FormNotice tone="error">{message}</FormNotice>
      <RefusalDetail detail={detail} />
    </div>
  );
}
