import type { BuildAssetRow } from "./asset";

/**
 * What the frame hands a kind's section above its list, such as the catalogue's services above
 * the Connections (CAT-PAGE).
 */
export interface BuildListHeadProps {
  /** The kind's assets, not narrowed by the search. Absent while they are read. */
  rows: readonly BuildAssetRow[] | undefined;
  /** The reader may start a new asset of the kind. */
  canCreate: boolean;
  /** The address of an asset's page, for a link to it. */
  hrefOf(name: string): string;
  /** Opens an asset's page. */
  open(name: string): void;
  /** Opens the kind's own New dialog at `start`, which the dialog reads as it likes. */
  create(start: string): void;
}
