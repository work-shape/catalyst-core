import type { ClientInstanceId } from "./ids";
import type { CentralPolicySetting } from "./operation-policy";
import type { PolicyValue } from "./operations";
import type { ISODateString } from "./time";

// The admin's central policy (OP-2): a value per operation or name pattern, narrowed to a
// workspace and an asset kind where the admin chose, and the operations whose "Always allow"
// the admin locked. Set on Instance > Policies; `resolvePolicy()` reads them on every call.

/**
 * At most so many settings, and so many locks, an instance holds. Every call reads them all, so
 * a new one past this is refused instead of read in part: a `deny` that is not read is ignored.
 */
export const CENTRAL_POLICY_ENTRIES_MAX = 2_000;

/** One stored central setting, with when it was last set. */
export interface StoredCentralPolicySetting extends CentralPolicySetting {
  updatedAt: ISODateString;
}

/** An operation or pattern whose "Always allow" the admin locked on the Policies screen. */
export interface StoredAlwaysAllowLock {
  operation: string;
  updatedAt: ISODateString;
}

/** Where a central setting applies: its operation or pattern and what it is narrowed to. */
export interface CentralPolicySettingKey {
  operation: string;
  workspaceId?: string;
  assetKind?: string;
}

export interface CentralPolicySettingStore {
  list(input: { clientInstanceId: ClientInstanceId }): Promise<StoredCentralPolicySetting[]>;
  /**
   * Sets the value of one setting, or removes it with `null`. Answers the value it had before.
   * A setting is one per operation, workspace and asset kind. A new one where the instance
   * holds `CENTRAL_POLICY_ENTRIES_MAX` already is not stored, and the answer says `full`.
   */
  set(
    input: CentralPolicySettingKey & {
      clientInstanceId: ClientInstanceId;
      value: PolicyValue | null;
      at: ISODateString;
    }
  ): Promise<{ previous: PolicyValue | undefined; full?: true }>;
  listLocks(input: { clientInstanceId: ClientInstanceId }): Promise<StoredAlwaysAllowLock[]>;
  /**
   * Locks or unlocks one operation or pattern. Answers whether it was locked before. A new lock
   * where the instance holds `CENTRAL_POLICY_ENTRIES_MAX` already is not stored: `full`.
   */
  setLock(input: {
    clientInstanceId: ClientInstanceId;
    operation: string;
    locked: boolean;
    at: ISODateString;
  }): Promise<{ wasLocked: boolean; full?: true }>;
}
