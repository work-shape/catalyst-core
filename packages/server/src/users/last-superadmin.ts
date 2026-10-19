import {
  AppError,
  isSuperadmin,
  type ClientInstanceId,
  type PlatformStores,
  type UserRecord,
  type UserRecordStatus
} from "@work-shape/catalyst-core";

/** What a change leaves of the person: their roles and status after it, or nothing. */
export type PersonAfterChange = { roles: readonly string[]; status: UserRecordStatus } | "deleted";

/**
 * The one last-superadmin check (ADR-0028). A change that would leave the instance without an
 * active person who holds `superadmin` is refused: removing the role, deactivating the person or
 * deleting them. Every path that does one of these calls it, under the rights locks, so two
 * superadmins cannot each remove the other: user administration, through the interface, the
 * API and the CLI alike, and the sign-in sync and the provisioning feed when they arrive.
 */
export async function requireActiveSuperadminRemains(
  options: { clientInstanceId: ClientInstanceId; stores: Pick<PlatformStores, "users"> },
  person: Pick<UserRecord, "id" | "roles" | "status">,
  after: PersonAfterChange
): Promise<void> {
  if (person.status !== "active" || !isSuperadmin(person)) return;
  if (after !== "deleted" && after.status === "active" && isSuperadmin(after)) return;
  const remains = await options.stores.users.hasOtherActiveSuperadmin({
    clientInstanceId: options.clientInstanceId,
    userId: person.id
  });
  if (!remains) {
    throw new AppError("VALIDATION_FAILED", "At least one active superadmin must remain", {
      reason: "last_superadmin"
    });
  }
}
