import type { ConfigAssetStore, JsonObject, PlatformAction } from "@vivd-catalyst/core";

/**
 * A kind of held call whose request the holders of its own right decide, and which knows what
 * the call is about: the `subject` its operation's `approval` froze when the call was held.
 */
export interface HeldCallApprovalKind {
  kind: string;
  /** Who decides, and who is shown the request among those to decide. */
  requiredPermission: PlatformAction;
  /**
   * Why the call can no longer be approved, though it still waits: what it is about moved
   * since. Read through the stores of the decision's transaction.
   */
  moved(
    subject: JsonObject,
    store: Pick<ConfigAssetStore, "getConfigAsset">
  ): Promise<string | undefined>;
  /**
   * What a request shows of what the call is about: for one opened request all of it, with
   * `stale` where it moved; for a row of a list what the subject itself says, reading nothing.
   */
  review(subject: JsonObject, inList: boolean): Promise<JsonObject | undefined>;
  /**
   * The fields of a subject that say what it is about. A newer request whose subject holds
   * the same replaces the one that still waits.
   */
  subjectKey(subject: JsonObject): JsonObject;
}
