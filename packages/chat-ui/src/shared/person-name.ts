import type { TranslationContextValue } from "./i18n";

/**
 * The name shown for a person the server named by their account: the name it sent, or
 * "Deleted account" where it sent none. The server sends an empty name for an account that is
 * gone or whose deletion was requested, never the account's id.
 */
export function personName(name: string | undefined, t: TranslationContextValue["t"]): string {
  return name?.trim() ? name : t("deletedAccount");
}
