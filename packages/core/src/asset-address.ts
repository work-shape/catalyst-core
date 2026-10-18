/**
 * The address a create dialog makes from a name: lowercase letters and digits in words joined
 * by '-', starting with a letter, at most 63 characters. It is the strictest name rule of any
 * kind (a Data Store's and a Knowledge Base's), so every kind takes it, and it reads as one
 * with a prefix such as `kai-`.
 */
export const ASSET_ADDRESS_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const ASSET_ADDRESS_MAX_LENGTH = 63;

/**
 * The address made from the name people read, by `ASSET_ADDRESS_PATTERN`: German letters keep
 * their sound, other accents are dropped, and every other run of characters is a '-'. An
 * address that would not start with a letter starts with the word of its kind, such as
 * `knowledge-base-2026` for "2026", so every name that is not empty makes one.
 */
export function assetAddressFromName(name: string, kindWord: string): string {
  const words = name
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (name.trim() === "") return "";
  const address = /^[a-z]/u.test(words)
    ? words
    : [kindWord.replaceAll("_", "-"), words].filter(Boolean).join("-");
  return address.slice(0, ASSET_ADDRESS_MAX_LENGTH).replace(/-+$/u, "");
}
