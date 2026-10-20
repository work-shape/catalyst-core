import type { Asset, AssetSummary } from "@work-shape/catalyst-api-client";
import type { PageHeaderProps } from "@work-shape/catalyst-ui";

/** What a page puts at the end of its head: Publish, History and the "…" menu with Delete. */
export type BuildHeadActions = Pick<PageHeaderProps, "primaryAction" | "secondaryActions" | "menu">;

/** One asset as a list shows it: what the instance says of it without its content. */
export type BuildAssetRow = AssetSummary;

/** One asset as its page loaded it. The page writes against this revision and no later one. */
export type BuildAsset = Asset;
