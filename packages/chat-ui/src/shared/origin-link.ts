/**
 * The origin link of a Knowledge Base document as a page may render it: an `http` or `https`
 * address with the host it names. Anything else, a `javascript:` or `data:` address among them,
 * is left out, so a link never runs script when it is opened. The server takes only web
 * addresses; this holds for a link stored before it did.
 */
export function safeOriginLink(
  link: string | undefined
): { href: string; host: string } | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:"
      ? { href: url.href, host: url.host }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Opens an origin link in a new tab that cannot reach back into this page. */
export function openOriginLink(href: string): void {
  window.open(href, "_blank", "noopener,noreferrer");
}
