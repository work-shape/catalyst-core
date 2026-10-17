// Reads the Bearer challenge of a `WWW-Authenticate` header (RFC 6750, RFC 9110 section 11):
// the protected resource metadata address (RFC 9728) and the scopes the server asks for.
// The header is untrusted text of the outside system. Only these parameters are taken from
// it, each bounded, and none of it is ever written to a log or an answer.

/** The longest header that is read. A longer one is read as no challenge. */
export const CHALLENGE_MAX_CHARS = 8 * 1024;
/** The most scopes a challenge may name; the rest are not read. */
export const CHALLENGE_MAX_SCOPES = 64;
/** The longest scope name that is taken. */
const SCOPE_MAX_CHARS = 256;

export interface BearerChallenge {
  /** The `resource_metadata` parameter: where the protected resource metadata is. */
  resourceMetadataUrl?: string;
  /** The `scope` parameter, split on spaces. */
  scopes?: string[];
  /** The `error` parameter, such as `invalid_token` or `insufficient_scope`. */
  error?: string;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/u;
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*/u;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

/** Reads a quoted string at the start of `text`. Answers its value and what follows. */
function quoted(text: string): { value: string; rest: string } | undefined {
  let value = "";
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      if (index >= text.length) return undefined;
      value += text[index];
    } else if (char === '"') {
      return { value, rest: text.slice(index + 1) };
    } else {
      value += char;
    }
  }
  return undefined;
}

/** The parameters of each challenge of the header, by scheme in lower case. */
function challengesOf(header: string): Array<{ scheme: string; params: Map<string, string> }> {
  const challenges: Array<{ scheme: string; params: Map<string, string> }> = [];
  let rest = header.trim();
  let current: { scheme: string; params: Map<string, string> } | undefined;
  while (rest.length > 0) {
    rest = rest.replace(/^[\s,]+/u, "");
    if (rest.length === 0) break;
    const name = TOKEN.exec(rest)?.[0];
    if (name === undefined) return challenges;
    const after = rest.slice(name.length).replace(/^\s*/u, "");
    if (after.startsWith("=") && current !== undefined && !after.startsWith("==")) {
      // A parameter of the current challenge.
      const valueText = after.slice(1).replace(/^\s*/u, "");
      let value: string;
      if (valueText.startsWith('"')) {
        const read = quoted(valueText);
        if (read === undefined) return challenges;
        value = read.value;
        rest = read.rest;
      } else {
        const token = TOKEN.exec(valueText)?.[0];
        if (token === undefined) return challenges;
        value = token;
        rest = valueText.slice(token.length);
      }
      const key = name.toLowerCase();
      // A parameter named twice makes the challenge unreadable (RFC 9110 11.2).
      if (current.params.has(key)) {
        current.params.clear();
        return challenges;
      }
      current.params.set(key, value);
      continue;
    }
    // A new challenge: its scheme, then a token68 or parameters.
    current = { scheme: name.toLowerCase(), params: new Map() };
    challenges.push(current);
    rest = after;
    const token68 = TOKEN68.exec(rest)?.[0];
    if (
      token68 !== undefined &&
      !/^\s*=[^=]/u.test(rest.slice(token68.replace(/=+$/u, "").length))
    ) {
      rest = rest.slice(token68.length);
    }
  }
  return challenges;
}

/**
 * The Bearer challenge of a `WWW-Authenticate` value, or nothing where it holds none or is
 * not readable. A `resource_metadata` that is no `https` or `http` address is left out.
 */
export function parseBearerChallenge(header: string | undefined): BearerChallenge | undefined {
  if (header === undefined || header.length === 0 || header.length > CHALLENGE_MAX_CHARS) {
    return undefined;
  }
  const bearer = challengesOf(header).find((challenge) => challenge.scheme === "bearer");
  if (bearer === undefined) return undefined;
  const challenge: BearerChallenge = {};
  const metadata = bearer.params.get("resource_metadata");
  if (metadata !== undefined) {
    try {
      const url = new URL(metadata);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === ""
      ) {
        challenge.resourceMetadataUrl = url.href;
      }
    } catch {
      // Not an address: read as none.
    }
  }
  const scope = bearer.params.get("scope");
  if (scope !== undefined) {
    const scopes = scope
      .split(" ")
      .filter((name) => name.length > 0 && name.length <= SCOPE_MAX_CHARS && SCOPE_TOKEN.test(name))
      .slice(0, CHALLENGE_MAX_SCOPES);
    if (scopes.length > 0) challenge.scopes = [...new Set(scopes)];
  }
  const error = bearer.params.get("error");
  if (error !== undefined && TOKEN.exec(error)?.[0] === error && error.length <= 64) {
    challenge.error = error;
  }
  return challenge;
}
