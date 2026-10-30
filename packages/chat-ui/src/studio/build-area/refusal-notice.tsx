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
 *
 * With `untold` the message beside it says no reason: the detail then stands open for who may
 * read it, and everyone else is told who reads it and where.
 */
export function RefusalDetail({
  detail,
  untold
}: {
  detail: string | undefined;
  untold?: boolean;
}) {
  const page = useOptionalSettingsPage();
  if (detail === undefined) return null;
  if (page === undefined) return untold ? <ReasonWho /> : null;
  return <SystemRefusalDetail detail={detail} page={page} untold={untold ?? false} />;
}

function SystemRefusalDetail({
  detail,
  page,
  untold
}: {
  detail: string;
  page: Pick<SettingsPageContextValue, "apiBaseUrl" | "authScope" | "client">;
  untold: boolean;
}) {
  const { t } = useTranslation();
  const platform = usePlatformContextQuery({
    apiBaseUrl: page.apiBaseUrl,
    authScope: page.authScope,
    client: page.client,
    enabled: true
  });
  // Until the instance says who reads, neither the detail nor who reads it shows.
  if (platform.data === undefined) return platform.isError && untold ? <ReasonWho /> : null;
  if (!canViewSystem(platform.data)) return untold ? <ReasonWho /> : null;
  return (
    <Disclosure defaultOpen={untold} data-refusal-detail="">
      <DisclosureTrigger>{t("connectionCreate.details")}</DisclosureTrigger>
      <DisclosureContent>{detail}</DisclosureContent>
    </Disclosure>
  );
}

/** Who reads the reason of a refusal the reader is not shown, and where. */
function ReasonWho() {
  const { t } = useTranslation();
  return (
    <p className="text-caption text-muted-foreground" data-refusal-reason-who="">
      {t("connections.reasonWho")}
    </p>
  );
}

/** A refused change in the reader's words, with the instance's sentence for who runs it. */
export function RefusalNotice({
  message,
  detail,
  untold
}: {
  message: string;
  detail?: string;
  untold?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <FormNotice tone="error">{message}</FormNotice>
      <RefusalDetail detail={detail} untold={untold ?? false} />
    </div>
  );
}
