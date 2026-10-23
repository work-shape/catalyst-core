import type { AssetFileWrite, CheckName } from "../../../shared/api/asset-writes";
import type { BuildWriteOutcome } from "../build-refusals";

/**
 * What the frame hands a kind's own dialog for a new asset, in place of the one that asks for
 * the name and the id: the check of the name, and the writes of the asset.
 */
export interface BuildCreateDialogProps {
  /** Asks the instance whether the asset could take the name, as it is typed. */
  checkName: CheckName;
  /** Writes the asset's definition: creates it at `null`, else over the revision given. */
  put(input: {
    name: string;
    config: Record<string, unknown>;
    expectedRevision: number | null;
  }): Promise<{ revision: number }>;
  /** Deletes the asset the dialog made, where the reader may (`mayDelete`). */
  remove(input: { name: string; expectedRevision: number }): Promise<unknown>;
  /** Whether the reader may delete the asset the dialog made. */
  mayDelete(): boolean;
  onClose(): void;
  /**
   * The asset exists: the frame closes the dialog and opens its page. `then` runs once the
   * page is open, such as opening the chat beside it.
   */
  onCreated(name: string, then?: () => void): void;
}

/**
 * What the frame hands a kind's dialog that imports an asset from files, beside New: the
 * check of the name, the create of the asset with its whole folder, and the way to its page.
 */
export interface BuildImportDialogProps {
  /** Asks the instance whether the asset could take the name, as it is typed. */
  checkName: CheckName;
  /** Creates the asset with its whole folder where Studio makes one, as a save of its page. */
  create(input: { name: string; files: readonly AssetFileWrite[] }): Promise<BuildWriteOutcome>;
  /**
   * The asset that holds `name`, read now: the name people read of it, and whether the reader
   * may change it here. Undefined where it cannot be read.
   */
  existing(name: string): Promise<{ title: string; writable: boolean } | undefined>;
  onClose(): void;
  /** Closes the dialog and opens the page of the asset: the one it made, or one that exists. */
  onOpen(name: string): void;
}
