import { useState, type ReactNode } from "react";
import type { PagePreviewResponse } from "@work-shape/catalyst-api-client";
import { Banner, Button } from "@work-shape/catalyst-ui";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation } from "../../shared/i18n";

type Asking = "idle" | "busy" | "waits" | "failed";

/**
 * The outside hosts a preview of a draft holds back, and where the release and the viewer's
 * rights allow it, the click that lets the viewer's own preview call them (DRAFT-HOSTS-1). The
 * click allows each host the viewer may allow; the frame then asks for its address again, so
 * its next load carries the hosts. Without an offer it shows `fallback`.
 */
export function DraftHostsNotice({
  fileSetId,
  heldBackHosts,
  draftHosts,
  fallback,
  onAllowed
}: {
  fileSetId: string | undefined;
  heldBackHosts: readonly string[];
  draftHosts: PagePreviewResponse["draftHosts"];
  fallback?: ReactNode;
  onAllowed(): void;
}) {
  const { t } = useTranslation();
  const { client } = useWorkspaceApiClient();
  const [asking, setAsking] = useState<Asking>("idle");
  const allowable = draftHosts?.allowable ?? [];
  if (heldBackHosts.length === 0) {
    return null;
  }
  if (fileSetId === undefined || allowable.length === 0) {
    return fallback ?? null;
  }

  const allow = async () => {
    setAsking("busy");
    try {
      for (const host of allowable) {
        const outcome = await client.apps.allow_draft_host({ body: { fileSetId, host } });
        if (outcome.status !== "done") {
          setAsking("waits");
          return;
        }
      }
      setAsking("idle");
      onAllowed();
    } catch {
      setAsking("failed");
    }
  };

  const hosts = allowable.join(", ");
  return (
    <Banner
      layout="page"
      className="shrink-0"
      data-testid="draft-hosts-notice"
      tone={asking === "failed" ? "danger" : "info"}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={asking === "busy" || asking === "waits"}
          onClick={() => {
            allow().catch(() => setAsking("failed"));
          }}
        >
          {t("apps.draftHostsAllow")}
        </Button>
      }
    >
      <span>{t("apps.draftHostsHeld", { hosts })}</span>{" "}
      {draftHosts?.readsData ? <span>{t("apps.draftHostsReadsData")}</span> : null}{" "}
      <span>
        {asking === "waits"
          ? t("apps.draftHostsWaits")
          : asking === "failed"
            ? t("apps.draftHostsFailed", { hosts })
            : t("apps.draftHostsOnlyYou")}
      </span>
    </Banner>
  );
}
