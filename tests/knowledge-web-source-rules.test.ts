import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { knowledgeSourceDefaults } from "@work-shape/catalyst-client-assembly";
import {
  createWebConnectorType,
  parseRobots,
  readHtmlPage
} from "@work-shape/catalyst-connections";
import {
  sourceBoundary,
  sourceBoundaryKey,
  sourceDefaultsOfType,
  sourceScheduleOf,
  withinSource
} from "@work-shape/catalyst-data-stores";

// The rules of a web source (KB-WEB) that need no site: how its boundary reaches the sync, how
// a page is read and how robots.txt is applied.

describe("a web source's boundary", () => {
  it("hands the sync its addresses in place of folders, with their kinds and depth", () => {
    const source = {
      id: "web",
      connection: "pages",
      pages: ["https://www.example.org/a"],
      prefixes: ["https://www.example.org/docs/"],
      include: ["/docs/**"]
    };
    expect(sourceBoundary(source)).toEqual({
      folderIds: ["https://www.example.org/a", "https://www.example.org/docs/"],
      web: {
        pages: ["https://www.example.org/a"],
        prefixes: ["https://www.example.org/docs/"],
        sitemaps: [],
        maxDepth: 3,
        include: ["/docs/**"]
      }
    });
    // A web source's include is on the address's path; a folder source's stays on the name.
    const item = {
      parents: ["https://www.example.org/docs/"],
      name: "Handbook",
      path: "/docs/handbook"
    };
    expect(withinSource(source, item)).toBe(true);
    expect(withinSource(source, { ...item, path: "/other" })).toBe(false);
    expect(
      withinSource(
        { id: "f", connection: "c", folders: ["1"], include: ["*.pdf"] },
        { parents: ["1"], name: "a.pdf", path: "/x/a.pdf" }
      )
    ).toBe(true);
  });

  it("keeps the boundary key of a folder source as it was, so no cursor is reset", () => {
    const source = { id: "f", connection: "c", folders: ["2", "1"], include: ["*.pdf"] };
    expect(sourceBoundaryKey(source)).toBe(
      createHash("sha256")
        .update(JSON.stringify(["c", ["1", "2"], ["*.pdf"], undefined]))
        .digest("hex")
    );
    const web = { id: "w", connection: "c", prefixes: ["https://www.example.org/docs/"] };
    expect(sourceBoundaryKey(web)).not.toBe(sourceBoundaryKey({ ...web, maxDepth: 1 }));
  });
});

describe("reading a page", () => {
  it("keeps the main text and the page's own date, and drops navigation, scripts and forms", () => {
    const page = readHtmlPage(
      `<html><head><title>EStG &sect; 7</title><script>alert(1)</script><style>p{}</style></head>
       <body><header>Logo</header><nav><a href="/nav">Nav</a></nav>
       <main><h1>&sect; 7 Absetzung f&uuml;r Abnutzung</h1><p>Stand: 01.11.2026</p>
       <table><tr><td>Satz</td><td>2 %</td></tr></table>
       <form><input name="q"></form><a href="other#part">Next</a></main>
       <footer>Impressum</footer></body></html>`,
      new URL("https://www.example.org/estg/__7.html")
    );
    expect(page.title).toBe("EStG § 7");
    expect(page.markdown).toBe(
      "# EStG § 7\n\n# § 7 Absetzung für Abnutzung\n\nStand: 01.11.2026\n\nSatz | 2 %\n\nNext"
    );
    expect(page.links).toEqual([
      "https://www.example.org/nav",
      "https://www.example.org/estg/other"
    ]);
    expect(page.statedDate).toBe("2026-11-01T00:00:00.000Z");
  });

  it("reads a date a meta tag states before a line of the text", () => {
    const page = readHtmlPage(
      `<html><head><meta name="dcterms.modified" content="2026-03-02"></head><body><p>Last updated: 1 January 2020</p></body></html>`,
      new URL("https://www.example.org/")
    );
    expect(page.statedDate).toBe("2026-03-02T00:00:00.000Z");
  });

  it.each([
    ["01.11.2026", "2026-11-01"],
    ["1. November 2026", "2026-11-01"],
    ["v. 22.12.2023 I 3366", "2023-12-22"],
    ["March 3, 2025", "2025-03-03"],
    ["31.02.2026", undefined]
  ])("reads Stand: %s as a date", (text, date) => {
    const page = readHtmlPage(`<p>Stand: ${text}</p>`, new URL("https://www.example.org/"));
    expect(page.statedDate?.slice(0, 10)).toBe(date);
  });

  it("follows no script, mail or other-scheme link", () => {
    const page = readHtmlPage(
      `<a href="javascript:alert(1)">x</a><a href="mailto:a@b.c">m</a><a href="http://www.example.org/plain">p</a><a href="https://u:p@www.example.org/">c</a>`,
      new URL("https://www.example.org/")
    );
    expect(page.links).toEqual([]);
  });
});

describe("robots.txt", () => {
  const robots = `User-agent: *
Disallow: /private
Allow: /private/open
Disallow: /*.json$
Crawl-delay: 4

User-agent: Catalyst-Knowledge
Disallow: /only-for-others
Crawl-delay: 60`;

  it("applies the group naming the product token, the longest rule winning", () => {
    const rules = parseRobots(robots, "Catalyst-Knowledge");
    expect(rules.allows("/private")).toBe(true);
    expect(rules.allows("/only-for-others/x")).toBe(false);
    expect(rules.crawlDelayMs).toBe(10_000);
  });

  it("falls back to the * group with wildcards and anchors", () => {
    const rules = parseRobots(robots, "SomeoneElse");
    expect(rules.allows("/private/x")).toBe(false);
    expect(rules.allows("/private/open/x")).toBe(true);
    expect(rules.allows("/data.json")).toBe(false);
    expect(rules.allows("/data.json?x")).toBe(true);
    expect(rules.crawlDelayMs).toBe(4_000);
  });
});

describe("when a web source syncs", () => {
  it("polls hourly at most and passes in full each Monday, unless the source says otherwise", () => {
    const byType = knowledgeSourceDefaults({}, [createWebConnectorType()]);
    const defaults = sourceDefaultsOfType(byType, "web");
    expect(defaults).toEqual({ changes: 60, full: "0 3 * * 1", minChanges: 60 });
    const source = { id: "web", connection: "pages", prefixes: ["https://www.example.org/docs/"] };
    expect(sourceScheduleOf(source, defaults)).toEqual({ changes: 60, full: "0 3 * * 1" });
    expect(
      sourceScheduleOf({ ...source, schedule: { changes: 240, full: "off" } }, defaults)
    ).toEqual({ changes: 240, full: "off" });
    expect(sourceScheduleOf({ ...source, schedule: { changes: "off" } }, defaults).changes).toBe(
      "off"
    );
  });
});
