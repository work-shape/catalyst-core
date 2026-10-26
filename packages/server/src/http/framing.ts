/**
 * Who may frame a document the API serves: the instance itself and the origins the interface
 * runs on, which are the origins the API answers across (`allowedOrigins`). Every framed
 * document of the API takes its `frame-ancestors` from here, so a list of sites that embed the
 * chat becomes one input of this module. The interface's own document is served by the proxy
 * image and says `'self'` (`deployment-kit/docker/nginx-spa.conf`).
 */
export function frameAncestors(allowedOrigins: readonly string[]): string {
  return `frame-ancestors ${["'self'", ...allowedOrigins.filter(isPolicySource)].join(" ")}`;
}

/**
 * The header for a browser without `frame-ancestors`. It cannot name an origin; a browser that
 * reads the policy ignores it, so the origins above still frame the document there.
 */
export const FRAME_OPTIONS_HEADERS = { "x-frame-options": "SAMEORIGIN" } as const;

/**
 * Whether a policy can name an origin. The grammar of a source has no address in brackets, so
 * an interface that runs on an IPv6 literal cannot frame a document; a browser would ignore the
 * source and say so on every answer.
 */
function isPolicySource(origin: string): boolean {
  return URL.canParse(origin) && !new URL(origin).hostname.startsWith("[");
}
