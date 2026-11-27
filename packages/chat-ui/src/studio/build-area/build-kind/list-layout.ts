import type { ReactNode } from "react";
import type { BuildAssetRow } from "./asset";

/**
 * What the frame hands a kind that lays out its own list page (`ListLayout`), such as the
 * Connections, which stand under "My connections" and, for who manages them, on a tab of
 * their own (CONN-IA). The kind places the frame's list and says what stands around it.
 */
export interface BuildListLayoutProps {
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
  /** The frame's list: its search, its filters, its rows and its states. */
  list: ReactNode;
  /** The kind's section below the list (`listAside`), or nothing where it holds no row. */
  aside: ReactNode;
  /** The tab the reader chose on this page, kept while they open an asset and come back. */
  tab: string | undefined;
  onTabChange(tab: string): void;
}
