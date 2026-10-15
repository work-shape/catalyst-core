import type { ClientInstanceId } from "./ids";

/**
 * The locks every write that changes who holds what takes first, in one order: the instance's,
 * then the row of the user the write is about (`userId`). Held to the end of the transaction of
 * the store that takes them, so the store is one of `PlatformStores.transaction`. A check made
 * under them stays true until the write after it commits.
 */
export interface RightsLock {
  lockRights(input: { clientInstanceId: ClientInstanceId; userId?: string }): Promise<void>;
}
