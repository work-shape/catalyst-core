import { z } from "zod";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True for an origin a browser may be sent back to: `https`, or `http` on a loopback host
 * for local development. Only the origin counts; a path, query, fragment or user part is refused
 * so the redirect URI built on it is one fixed string.
 */
function isPublicOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
}

/**
 * Facts about where the instance is reached. `publicUrl` is the origin a person's browser opens
 * the instance on; an OAuth sign-in for a Connection sends the provider back to
 * `<publicUrl>/api/v1/connections/<name>/oauth/callback`. Without it, Connect is refused.
 */
export const instanceConfigSchema = z
  .object({
    publicUrl: z
      .string()
      .refine(isPublicOrigin, {
        message:
          "instance.publicUrl is an origin such as 'https://chat.example.test' ('http' only for localhost), without a path"
      })
      .transform((value) => new URL(value).origin)
      .optional()
  })
  .default({});

export type InstanceConfig = z.infer<typeof instanceConfigSchema>;
