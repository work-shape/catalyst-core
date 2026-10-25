import { asUserId, type ClientInstanceId } from "./ids";
import type { UserStore } from "./user";

// How a person is shown from a stored account id (access-and-permissions.md, Deleting an
// account): by the name the instance holds now, looked up when shown. An id that resolves to no
// account, or to one whose deletion was requested, is shown as a deleted account, never as the
// raw id; so is an empty stored label, the copy the account's deletion emptied.

/** What text a model reads says of a person whose account is gone. */
export const DELETED_ACCOUNT_FOR_MODEL = "a deleted account";

/** The person's name as text a model reads: quoted, or "a deleted account" when there is none. */
export function personLabelForModel(label: string | undefined): string {
  return label ? JSON.stringify(label) : DELETED_ACCOUNT_FOR_MODEL;
}

/** The name shown for an account id: the stored label of whatever is not an account. */
export type PersonLabelLookup = (id: string, storedLabel: string) => Promise<string>;

/**
 * Looks up the names of people by account id, each id once per lookup, so one lookup serves
 * one read. Answers the name the account has now, or an empty string for an account that is
 * gone or whose deletion was requested; an interface shows the empty string as "Deleted
 * account". An id no account has that is not an account id (`usr_`), such as a technical
 * account's, keeps the label stored with it.
 */
export function createPersonLabelLookup(
  users: Pick<UserStore, "getUser">,
  clientInstanceId: ClientInstanceId
): PersonLabelLookup {
  const accounts = new Map<string, Promise<{ label: string } | undefined>>();
  return async (id, storedLabel) => {
    let account = accounts.get(id);
    if (account === undefined) {
      account = users
        .getUser({ clientInstanceId, userId: asUserId(id) })
        .then((user) =>
          user === undefined
            ? undefined
            : { label: user.status === "deleting" ? "" : user.displayLabel }
        );
      accounts.set(id, account);
    }
    const found = await account;
    if (found) return found.label;
    return id.startsWith("usr_") ? "" : storedLabel;
  };
}
