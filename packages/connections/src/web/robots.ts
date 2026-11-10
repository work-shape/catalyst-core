// `robots.txt` as a web source honours it (RFC 9309). The groups that name the source's product
// token apply, else the `*` group; among the rules that match a path the longest wins, and an
// `allow` wins a tie. A `Crawl-delay` the group sets slows the walk on that host, up to a cap.

export interface RobotsRules {
  allows(pathAndQuery: string): boolean;
  /** The pause the host asks for between requests, in milliseconds, where it asks for one. */
  crawlDelayMs?: number;
}

/** The longest pause a `Crawl-delay` makes a walk keep. */
const CRAWL_DELAY_MAX_MS = 10_000;

export const ALLOW_ALL: RobotsRules = { allows: () => true };

interface Rule {
  allow: boolean;
  pattern: string;
  matcher: RegExp;
}

function matcherOf(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`, "u");
}

/** A path as rules compare it: percent-encoding of unreserved characters undone. */
function normalized(path: string): string {
  return path.replace(/%([0-9a-f]{2})/giu, (whole, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/u.test(char) ? char : whole.toUpperCase();
  });
}

export function parseRobots(text: string, productToken: string): RobotsRules {
  const token = productToken.toLowerCase();
  const groups: { agents: string[]; rules: Rule[]; delay?: number }[] = [];
  let current: (typeof groups)[number] | undefined;
  let readingAgents = false;
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.replace(/#.*$/u, "").trim();
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!readingAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      readingAgents = true;
      continue;
    }
    readingAgents = false;
    if (!current) continue;
    if ((key === "allow" || key === "disallow") && value !== "") {
      const pattern = normalized(value);
      current.rules.push({ allow: key === "allow", pattern, matcher: matcherOf(pattern) });
    } else if (key === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) current.delay = seconds * 1_000;
    }
  }
  const named = groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && (token === agent || token.startsWith(agent)))
  );
  const chosen = named.length ? named : groups.filter((group) => group.agents.includes("*"));
  const rules = chosen.flatMap((group) => group.rules);
  const delays = chosen.flatMap((group) => (group.delay === undefined ? [] : [group.delay]));
  const delay = delays.length ? Math.min(Math.max(...delays), CRAWL_DELAY_MAX_MS) : undefined;
  return {
    allows(pathAndQuery) {
      const path = normalized(pathAndQuery);
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!rule.matcher.test(path)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        )
          best = rule;
      }
      return best?.allow ?? true;
    },
    ...(delay === undefined ? {} : { crawlDelayMs: delay })
  };
}
