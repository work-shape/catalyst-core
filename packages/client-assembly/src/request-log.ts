const REDACTED = "[redacted]";

/** Request targets are untrusted, including targets the router refuses to parse. */
export function redactRequestUrl(target: string): string {
  // Keep only the path: absolute-form requests can carry credentials in the authority.
  const relative = target.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/u, "");
  const withoutFragment = relative.split("#", 1)[0] ?? "";
  const question = withoutFragment.indexOf("?");
  const path = question < 0 ? withoutFragment : withoutFragment.slice(0, question);
  const safePath = redactTokenPath(path);
  if (question < 0) return safePath;

  const query = new URLSearchParams(withoutFragment.slice(question + 1));
  const fields = [...query].map(([key, value]) => {
    // This is the entire allow-list. A free-form limit is not harmless either.
    const safeValue = key === "limit" && /^[0-9]+$/u.test(value) ? value : REDACTED;
    return `${encodeURIComponent(key)}=${safeValue}`;
  });
  return fields.length === 0 ? safePath : `${safePath}?${fields.join("&")}`;
}

function redactTokenPath(path: string): string {
  // Decode bytes without throwing on malformed escapes. Match more loosely than routing,
  // so case, escaped separators and repeated slashes cannot expose a rejected token.
  const segments = path
    .replace(/%([0-9a-f]{2})/giu, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .split(/[/\\]+/u)
    .filter(Boolean);
  const sensitive = segments.findIndex((part) =>
    ["app-content", "reset-password"].includes(part.toLowerCase())
  );
  if (sensitive < 0) return path;
  // App content is <file set>/<token>/<arbitrary file path>. Hide the whole tail so
  // malformed addresses and private file names are covered as well as valid tokens.
  return `/${segments.slice(0, sensitive + 1).join("/")}/${REDACTED}`;
}
