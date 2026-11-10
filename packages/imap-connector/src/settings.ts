import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { normalizeEgressHost, type EgressTarget, type JsonObject } from "@work-shape/catalyst-core";

/** The port of IMAP over implicit TLS (RFC 8314). */
export const IMAPS_PORT = 993;
/** Plain IMAP, which upgrades with STARTTLS at best. This type never speaks it. */
const PLAIN_IMAP_PORT = 143;
/** How many folders one Connection reads. */
export const IMAP_FOLDERS_MAX = 20;
const FOLDER_NAME_MAX_CHARS = 200;
const USERNAME_MAX_CHARS = 320;

/** No control character, no line break: a value goes into an IMAP command as one string. */
const PRINTABLE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const HOST_NAME =
  /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?))*$/iu;

const folderName = z
  .string()
  .min(1)
  .max(FOLDER_NAME_MAX_CHARS)
  .regex(PRINTABLE, { message: "A folder name holds no control character or line break" });

/**
 * The settings of an `imap` Connection: the server, the account's user name and the folders it
 * reads, which are its boundary. The password is the Connection's own secret and never a
 * setting.
 */
export const imapSettingsSchema = z.strictObject({
  host: z
    .string()
    .min(1)
    .max(253)
    .refine((host) => HOST_NAME.test(host) || isIP(host) !== 0, {
      message: "The host is one host name or one address, without a scheme, port or path"
    }),
  port: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .refine((port) => port !== PLAIN_IMAP_PORT, {
      message: `Port ${PLAIN_IMAP_PORT} is plain IMAP. This type connects over implicit TLS only, on ${IMAPS_PORT} by default`
    })
    .default(IMAPS_PORT),
  username: z
    .string()
    .min(1)
    .max(USERNAME_MAX_CHARS)
    .regex(PRINTABLE, { message: "The user name holds no control character or line break" })
    .refine((name) => name.trim() === name, {
      message: "The user name has no space at its start or end"
    }),
  folders: z
    .array(folderName)
    .min(1)
    .max(IMAP_FOLDERS_MAX)
    .refine((folders) => new Set(folders).size === folders.length, {
      message: "A folder is listed once"
    })
    .default(["INBOX"])
});

export type ImapSettings = z.infer<typeof imapSettingsSchema>;

/** The settings of a Connection its schema accepted. */
export function imapSettingsOf(settings: JsonObject): ImapSettings {
  return imapSettingsSchema.parse(settings);
}

export function imapTarget(settings: JsonObject): EgressTarget {
  const { host, port } = imapSettingsOf(settings);
  return { protocol: "imaps", host: normalizeEgressHost(host), port };
}

/**
 * The account the password is bound to beside the origin: a digest of the user name, so the
 * name itself is not stored next to the secret.
 */
export function imapCredentialAccount(settings: JsonObject): string {
  return createHash("sha256")
    .update(`imap-user\n${imapSettingsOf(settings).username}`)
    .digest("hex");
}
