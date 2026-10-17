import type { ConfigAssetRecord } from "@work-shape/catalyst-core";

/**
 * How many rows one statement of a batch writes. A batch of 2,000 assets is written in a
 * handful of statements, so the time the lock is held grows with the bytes and not with a
 * round trip per asset.
 */
const ASSET_WRITE_CHUNK = 500;

/** One asset as a batch leaves it, followed through the mutations that name it. */
export interface WrittenAsset {
  id: string;
  kind: string;
  /** Whether the row is there before the batch. */
  stored: boolean;
  status: ConfigAssetRecord["status"];
  /** The highest revision number of the asset, the ones this batch adds included. */
  newest: number;
  activeRevisionId: string;
  /** The batch gave it a revision. */
  written: boolean;
  /** The batch deleted it, whatever it did to it afterwards. */
  deleted: boolean;
  /** An agent that is there after a create: it starts with an availability of its own. */
  created: boolean;
}

export function chunksOf<Row>(rows: readonly Row[]): Row[][] {
  const chunks: Row[][] = [];
  for (let start = 0; start < rows.length; start += ASSET_WRITE_CHUNK) {
    chunks.push(rows.slice(start, start + ASSET_WRITE_CHUNK));
  }
  return chunks;
}
