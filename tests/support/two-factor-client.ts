import { z } from "zod";
import { createHmac } from "node:crypto";

/** The time-based code an authenticator app shows for an `otpauth://` address, at `at`. */
export function totpCode(totpUri: string, at = Date.now()): string {
  const secret = new URL(totpUri).searchParams.get("secret");
  if (!secret) throw new Error("The address names no secret");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 15;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}

/** A code the address does not show now or in the next or last period. */
export function wrongCode(totpUri: string): string {
  const taken = new Set([-1, 0, 1].map((step) => totpCode(totpUri, Date.now() + step * 30_000)));
  for (let candidate = 0; ; candidate += 1) {
    const code = String(candidate).padStart(6, "0");
    if (!taken.has(code)) return code;
  }
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.replace(/=+$/u, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A browser's cookies for one host: what each answer set, sent with the next call. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(response: { headers: Headers } | { headers: Record<string, unknown> }): void {
    const raw =
      response.headers instanceof Headers
        ? response.headers.getSetCookie()
        : ([] as unknown[]).concat(response.headers["set-cookie"] ?? []).map(String);
    for (const line of raw) {
      const [pair = "", ...attributes] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key = "", setting = ""] = attribute.trim().split("=");
        return key.toLowerCase() === "max-age" && Number(setting) <= 0;
      });
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((name) => name.includes(fragment));
  }

  drop(fragment: string): void {
    for (const name of [...this.cookies.keys()]) {
      if (name.includes(fragment)) this.cookies.delete(name);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  copy(): CookieJar {
    const jar = new CookieJar();
    for (const [name, value] of this.cookies) jar.cookies.set(name, value);
    return jar;
  }
}

/** The sign-in library's address for one of its paths, below the mount the server gives it. */
export function authUrl(origin: string, path: string): URL {
  return new URL(`/api/auth${path}`, origin);
}

/** The answer of `/two-factor/enable`: the address for the app and the first backup codes. */
export const twoFactorSetupSchema = z.object({
  totpURI: z.string(),
  backupCodes: z.array(z.string())
});
export const backupCodesSchema = z.object({ backupCodes: z.array(z.string()) });
export const sessionUserSchema = z.object({ user: z.object({ id: z.string() }) });
export const recordIdSchema = z.object({ id: z.string() });
export const refusalReasonSchema = z
  .object({ error: z.object({ details: z.object({ reason: z.string() }).partial() }).partial() })
  .partial();

/** A JSON answer read through its schema. */
export async function readJson<Schema extends z.ZodType>(
  response: Response,
  schema: Schema
): Promise<z.output<Schema>> {
  return schema.parse(await response.json());
}
