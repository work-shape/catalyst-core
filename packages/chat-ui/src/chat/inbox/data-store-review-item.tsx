import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { RouteLink } from "../../studio/route-link";
import { useTranslation } from "../../shared/i18n";
import { useApprovalRevisionHost } from "../approvals/approval-revision-host";

// The one notice of a store whose records wait in "Prüfen": how many fields wait now and the
// way to the store's page. It names the store, never a field or a value. Its reader marks it
// handled; a later sync that flags a field files the next one.

/** The segment of the Data Stores in a Build address. */
const DATA_STORES_BUILD_PATH = "data-stores";

export interface DataStoreReviewPreview {
  store: string;
  title?: string;
  /** How many fields wait now. Absent where the instance could not count them. */
  flagged?: number;
}

/** The notice of an item's preview, or nothing where the preview is not one. */
export function parseDataStoreReviewPreview(preview: unknown): DataStoreReviewPreview | undefined {
  if (typeof preview !== "object" || preview === null || Array.isArray(preview)) return undefined;
  const store: unknown = Reflect.get(preview, "store");
  const title: unknown = Reflect.get(preview, "title");
  const flagged: unknown = Reflect.get(preview, "flagged");
  if (typeof store !== "string") return undefined;
  return {
    store,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof flagged === "number" ? { flagged } : {})
  };
}

/** The store as the notice names it: its title, otherwise its name. */
export function reviewStoreLabel(preview: DataStoreReviewPreview): string {
  return preview.title ?? preview.store;
}

export function DataStoreReviewBody({ item }: { item: ApprovalRequestView }) {
  const { t } = useTranslation();
  const host = useApprovalRevisionHost();
  const preview = parseDataStoreReviewPreview(item.preview);
  if (!preview) return null;
  const store = reviewStoreLabel(preview);
  return (
    <div className="grid min-w-0 gap-3" data-testid="inbox-data-store-review">
      <p className="min-w-0 break-words" data-review-flagged={preview.flagged ?? ""}>
        {preview.flagged === undefined
          ? t("inbox.dataStoreReviewTextNone", { store })
          : t(
              preview.flagged === 1 ? "inbox.dataStoreReviewTextOne" : "inbox.dataStoreReviewText",
              { count: String(preview.flagged), store }
            )}
      </p>
      <div>
        <RouteLink
          route={{ kind: "build-asset", assetKind: DATA_STORES_BUILD_PATH, name: preview.store }}
          variant="link"
          className="px-0"
          onOpen={(route) => host?.openRoute?.(route)}
        >
          {t("inbox.dataStoreReviewOpen")}
        </RouteLink>
      </div>
    </div>
  );
}
