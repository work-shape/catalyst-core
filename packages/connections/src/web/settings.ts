import { z } from "zod";

/** The Connector type of public web pages a Knowledge Base syncs (KB-WEB). */
export const WEB_CONNECTOR_TYPE = "web";

/** How many hosts one web Connection lists at most. */
const WEB_HOSTS_MAX = 50;

/**
 * One host a web Connection may read: a name or an IPv4 address, with a port where it is not
 * 443, and nothing else. No wildcard and no suffix: a subdomain is a host of its own.
 */
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(260)
  .refine(
    (text) => {
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/u.test(text)) return false;
      try {
        const url = new URL(`https://${text}/`);
        return url.host === text.replace(/:443$/u, "") && url.pathname === "/";
      } catch {
        return false;
      }
    },
    { error: "A host is a name such as 'example.com', with ':port' only where it is not 443" }
  )
  .transform((text) => text.replace(/:443$/u, ""));

/**
 * The settings of a `web` Connection: the hosts it may read, and how many requests a second it
 * sends to each, one unless set. It holds no secret: the pages are public and fetched without a
 * sign-in or a cookie. The New connection form types the hosts into one field, so a text of
 * hosts separated by spaces, commas or lines is read as the list.
 */
export const webSettingsSchema = z.strictObject({
  hosts: z.preprocess(
    (value) =>
      typeof value === "string" ? value.split(/[\s,]+/u).filter((host) => host !== "") : value,
    z
      .array(hostSchema)
      .min(1)
      .max(WEB_HOSTS_MAX)
      .refine((hosts) => new Set(hosts).size === hosts.length, { error: "A host is named once" })
  ),
  requestsPerSecond: z.number().gt(0).max(10).optional()
});

export type WebSettings = z.infer<typeof webSettingsSchema>;

/** A host as the settings and an address compare it: `host` or `host:port`. */
export function hostKeyOf(url: URL): string {
  return url.host;
}
