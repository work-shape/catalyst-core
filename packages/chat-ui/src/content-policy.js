// Plain JavaScript so that the Vite plugin beside it loads without a build.

/**
 * The content policy of the chat interface's document. It names where images, media, fonts
 * and connections may come from: the interface itself, `data:` and `blob:` addresses it makes,
 * the API when that is another origin, and the logo and favicon addresses of the release
 * config. A reply, a Markdown preview or a Mermaid diagram that names any other address loads
 * nothing from it, whatever draws it into the page. Scripts, styles and frames are not limited
 * here: a generated view and an App have documents and policies of their own.
 *
 * @param {{
 *   apiUrl?: string | undefined;
 *   apiPort?: string | number | undefined;
 *   imageUrls?: ReadonlyArray<string | undefined>;
 *   dev?: boolean;
 * }} input
 * @returns {string}
 */
export function createChatUiContentPolicy(input) {
  const api = apiSources(input.apiUrl, input.apiPort);
  const images = (input.imageUrls ?? []).map(absoluteOrigin).filter(isString);
  const connect = ["'self'", "blob:", "data:", ...api];
  if (input.dev) {
    // Vite's hot reload talks to the dev server over a WebSocket.
    connect.push("ws:", "wss:");
  }
  return [
    `img-src ${unique(["'self'", "data:", "blob:", ...api, ...images]).join(" ")}`,
    `media-src ${unique(["'self'", "data:", "blob:", ...api]).join(" ")}`,
    `font-src ${unique(["'self'", "data:", ...api]).join(" ")}`,
    `connect-src ${unique(connect).join(" ")}`
  ].join("; ");
}

/**
 * The API is the interface's own origin unless the build names another. A port alone means the
 * API runs on the page's host at that port, which a policy writes as any host at the port.
 *
 * @param {string | undefined} apiUrl
 * @param {string | number | undefined} apiPort
 * @returns {string[]}
 */
function apiSources(apiUrl, apiPort) {
  if (apiUrl) {
    const origin = absoluteOrigin(apiUrl);
    return origin ? [origin] : [];
  }
  const port = String(apiPort ?? "").trim();
  return /^\d+$/u.test(port) ? [`http://*:${port}`, `https://*:${port}`] : [];
}

/**
 * @param {string | undefined} address
 * @returns {string | undefined}
 */
function absoluteOrigin(address) {
  if (!address || !/^https?:\/\//iu.test(address)) {
    return undefined;
  }
  try {
    return new URL(address).origin;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isString(value) {
  return typeof value === "string";
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return Array.from(new Set(values));
}
