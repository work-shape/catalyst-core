import type { ClientInstanceId, UserStore } from "@work-shape/catalyst-core";

/** The most recently signed-in active superadmin's display name for help text, without exposing the user directory. */
export async function readInstanceAdminName(
  users: UserStore,
  clientInstanceId: ClientInstanceId
): Promise<string | undefined> {
  return users.getSuperadminName({ clientInstanceId });
}
