import type { CheckName } from "../../../shared/api/asset-writes";

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
