import { forwardedPath } from "../protocol";
const MAX_FORWARDED_BYTES = 64 * 1024 * 1024; // A 25 MiB file set plus kit/fonts, within a 512 MiB container.
const MAX_REQUESTS = 1000; // Twice the file set's 500-file ceiling, including kit dependencies.
export function createContentForwarder(options: {
  apiOrigin: string;
  interfaceOrigin: string;
  prefix: string;
  locale: string;
  deadline: number;
}) {
  let bytes = 0;
  let requests = 0;
  return async (method: string, raw: string, headers: Record<string, string>) => {
    const path = forwardedPath(method, raw, options.interfaceOrigin, options.prefix);
    if (!path || ++requests > MAX_REQUESTS || bytes >= MAX_FORWARDED_BYTES) return undefined;
    const response = await fetch(new URL(path, options.apiOrigin), {
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, options.deadline - Date.now())),
      headers: {
        "accept-language": options.locale,
        "sec-fetch-dest": headers["sec-fetch-dest"] ?? "iframe"
      }
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return undefined;
    }
    const parts: Uint8Array[] = [];
    if (response.body)
      for await (const part of response.body) {
        bytes += part.byteLength;
        if (bytes > MAX_FORWARDED_BYTES) throw new Error("Capture resource budget exceeded");
        parts.push(part);
      }
    const kept = Object.fromEntries(response.headers);
    for (const name of ["set-cookie", "content-encoding", "content-length", "transfer-encoding"])
      delete kept[name];
    return { status: response.status, headers: kept, body: Buffer.concat(parts) };
  };
}
