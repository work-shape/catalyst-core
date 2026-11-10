import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEgressChecker,
  createWebConnectorType,
  sourceHttpTransport,
  webSettingsSchema,
  type SourceHttpTransport
} from "@work-shape/catalyst-connections";
import {
  DocumentSourceError,
  type ConnectorContext,
  type DocumentSourceBoundary,
  type DocumentSourceChange,
  type DocumentSourceItem
} from "@work-shape/catalyst-core";

// The `web` Connector type (KB-WEB) against a fake site on 127.0.0.1, never the internet. The
// site is served over plain HTTP; the test's transport takes the real pinned transport and only
// switches the scheme of the grant, so every rule of the connector runs as in production: listed
// hosts, the egress checker on every hop, redirects, robots.txt, pacing and size caps. Spec:
// data-stores-and-knowledge-bases.md, "Web pages as a synced source".

interface Site {
  server: Server;
  port: number;
  host: string;
  /** Every request the site answered, with its time and headers. */
  requests: { path: string; at: number; headers: IncomingMessage["headers"] }[];
  routes: Map<string, (request: IncomingMessage, response: ServerResponse) => void>;
}

async function startSite(): Promise<Site> {
  const routes = new Map<string, Site["routes"] extends Map<string, infer R> ? R : never>();
  const requests: Site["requests"] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ path, at: Date.now(), headers: request.headers });
    const route = routes.get(path);
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" }).end("not here");
      return;
    }
    route(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The site has no port.");
  const port = address.port;
  return { server, port, host: `127.0.0.1:${port}`, requests, routes };
}

function html(body: string, headers: Record<string, string> = {}) {
  return (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers }).end(body);
  };
}

/** The pinned transport of production, with the grant's scheme switched to the site's HTTP. */
const plainTransport: SourceHttpTransport = (input) =>
  sourceHttpTransport({ ...input, grant: { ...input.grant, protocol: "http" } });

let site: Site;
/** A second local server no listed page may make the walk reach. */
let internal: Site;
let clock = Date.now();
let connectionNumber = 0;

const web = createWebConnectorType({
  transport: plainTransport,
  instanceUrl: "https://chat.example.test",
  now: () => clock
});
const source = requiredSource(web.documentSource);

function requiredSource<Capability>(capability: Capability | undefined): Capability {
  if (capability === undefined) throw new Error("The web type has no document source.");
  return capability;
}

/**
 * A context of a `web` Connection as the platform hands one out: the egress checker admits the
 * fake site as a private entry of the operator's list and judges everything else as public, as
 * `egress.allowPublicHttps` does. Each test gets a Connection of its own, so pacing and the kept
 * robots.txt of one never reach another.
 */
function contextFor(settings: Record<string, unknown>): ConnectorContext {
  const checker = createEgressChecker({
    allow: [
      {
        protocol: "https",
        host: "127.0.0.1",
        port: site.port,
        network: "private",
        cidrs: ["127.0.0.1/32"]
      }
    ],
    allowPublicHttps: true
  });
  connectionNumber += 1;
  const target = { protocol: "https" as const, host: "127.0.0.1", port: site.port };
  return {
    connection: {
      id: `web-${String(connectionNumber)}`,
      name: "public-pages",
      revision: 1,
      settings: { requestsPerSecond: 10, ...settings },
      authScheme: "none",
      operations: []
    },
    target: { ...target, address: "127.0.0.1", family: 4, network: "private" },
    checkEgress: (next) => checker.check(next),
    credentialFor: () => undefined,
    signal: new AbortController().signal
  };
}

const url = (path: string) => `https://${site.host}${path}`;

function boundaryOf(
  web: Partial<NonNullable<DocumentSourceBoundary["web"]>>
): DocumentSourceBoundary {
  const full = { pages: [], prefixes: [], sitemaps: [], maxDepth: 3, ...web };
  return { folderIds: [...full.pages, ...full.prefixes, ...full.sitemaps], web: full };
}

async function listAll(boundary: DocumentSourceBoundary, context: ConnectorContext) {
  const items: DocumentSourceItem[] = [];
  let pageToken: string | undefined;
  for (let calls = 0; calls < 50; calls++) {
    const page = await source.list({ boundary, ...(pageToken ? { pageToken } : {}) }, context);
    items.push(...page.items);
    pageToken = page.nextPageToken;
    if (!pageToken) return items;
  }
  throw new Error("The listing never ended");
}

async function fetchText(
  item: Pick<DocumentSourceItem, "id" | "version"> | undefined,
  context: ConnectorContext,
  maxBytes = 1_000_000
) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.fetch(
    { itemId: item?.id ?? "", version: item?.version ?? "", maxBytes },
    context
  ))
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function failureOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "answered";
  } catch (error) {
    return error instanceof DocumentSourceError ? error.sourceCode : String(error);
  }
}

const LAYOUT = (main: string, nav = "") =>
  `<!doctype html><html><head><title>${
    /<h1>(.*?)<\/h1>/u.exec(main)?.[1] ?? "Page"
  }</title><script>var secret = "never indexed";</script></head><body><nav>${nav}<a href="/other">Menu</a></nav><main>${main}</main><footer>Footer text</footer></body></html>`;

beforeAll(async () => {
  site = await startSite();
  internal = await startSite();
  internal.routes.set("/secret", html("<p>internal</p>"));
  site.routes.set("/robots.txt", (_request, response) => {
    response
      .writeHead(200, { "content-type": "text/plain" })
      .end("User-agent: *\nDisallow: /docs/private\n\nUser-agent: OtherBot\nDisallow: /\n");
  });
  site.routes.set(
    "/docs/",
    html(
      LAYOUT(
        `<h1>Handbook</h1><p>Stand: 01.11.2026</p><p>Start here.</p>
         <a href="/docs/a">A</a> <a href="docs/../b">B relative</a> <a href="/docs/files/terms.pdf">Terms</a>
         <a href="/docs/private/x">Private</a> <a href="/elsewhere">Outside the prefix</a>
         <a href="https://169.254.169.254/latest/meta-data">Metadata</a>
         <a href="https://${internal.host}/secret">Internal</a>`,
        '<a href="/docs/nav-only">Nav</a>'
      )
    )
  );
  site.routes.set(
    "/docs/a",
    html(
      LAYOUT(`<h1>Section A</h1><h2>Rules</h2><p>Alpha text.</p><a href="/docs/a/deep">Deeper</a>`)
    )
  );
  site.routes.set("/docs/a/deep", html(LAYOUT(`<h1>Deep</h1><p>Deep text.</p>`)));
  site.routes.set("/docs/nav-only", html(LAYOUT(`<h1>Nav page</h1><p>From the menu.</p>`)));
  site.routes.set("/b", html(LAYOUT(`<h1>B</h1>`)));
  site.routes.set("/elsewhere", html(LAYOUT(`<h1>Elsewhere</h1>`)));
  site.routes.set("/docs/private/x", html(LAYOUT(`<h1>Private</h1>`)));
  site.routes.set("/docs/files/terms.pdf", (_request, response) => {
    response
      .writeHead(200, { "content-type": "application/pdf", etag: '"pdf-1"', "content-length": "9" })
      .end("%PDF-1.4\n");
  });
  site.routes.set(
    "/single",
    html(LAYOUT(`<h1>Single page</h1><p>zuletzt geändert durch Art. 5 G v. 22.12.2023</p>`))
  );
});

afterAll(async () => {
  await Promise.all(
    [site, internal].map((one) => new Promise<void>((resolve) => one.server.close(() => resolve())))
  );
});

describe("the web Connection's settings", () => {
  it("reads hosts typed into one field and refuses anything that is not a bare host", () => {
    expect(
      webSettingsSchema.parse({ hosts: "www.example.org, docs.example.org\nexample.org:8443" })
        .hosts
    ).toEqual(["www.example.org", "docs.example.org", "example.org:8443"]);
    expect(webSettingsSchema.parse({ hosts: ["Example.org:443"] }).hosts).toEqual(["example.org"]);
    for (const hosts of [
      ["https://example.org"],
      ["example.org/path"],
      ["*.example.org"],
      ["user@example.org"],
      []
    ])
      expect(webSettingsSchema.safeParse({ hosts }).success).toBe(false);
  });
});

describe("listing a web source", () => {
  it("walks pages and a prefix on the listed host, to its depth, and honours robots.txt", async () => {
    const context = contextFor({ hosts: [site.host] });
    const boundary = boundaryOf({
      pages: [url("/single")],
      prefixes: [url("/docs/")],
      maxDepth: 1
    });
    const items = await listAll(boundary, context);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect([...byId.keys()].sort()).toEqual(
      [
        url("/single"),
        url("/docs/"),
        url("/docs/a"),
        url("/docs/nav-only"),
        url("/docs/files/terms.pdf")
      ].sort()
    );
    // Depth 1 stops before /docs/a/deep; /b and /elsewhere are not below the prefix; robots.txt
    // keeps /docs/private out; the other hosts are never followed.
    const handbook = byId.get(url("/docs/"));
    expect(handbook).toMatchObject({
      name: "Handbook",
      mime: "text/markdown",
      path: "/docs/",
      originLink: url("/docs/"),
      parents: [url("/docs/")],
      modifiedAt: "2026-11-01T00:00:00.000Z"
    });
    expect(byId.get(url("/single"))).toMatchObject({
      parents: [url("/single")],
      modifiedAt: "2023-12-22T00:00:00.000Z"
    });
    expect(byId.get(url("/docs/files/terms.pdf"))).toMatchObject({
      name: "terms.pdf",
      mime: "application/pdf",
      size: 9
    });
    expect(site.requests.some((request) => request.path.startsWith("/docs/private"))).toBe(false);
    expect(internal.requests).toEqual([]);
    expect(
      site.requests.every(
        (request) =>
          request.headers["user-agent"] === "Catalyst-Knowledge/1.0 (+https://chat.example.test)"
      )
    ).toBe(true);
    expect(site.requests.every((request) => request.headers.cookie === undefined)).toBe(true);
  });

  it("applies include and exclude to the address's path before reading", async () => {
    const context = contextFor({ hosts: [site.host] });
    const before = site.requests.length;
    const boundary = boundaryOf({
      prefixes: [url("/docs/")],
      maxDepth: 2,
      include: ["/docs/a/**", "/docs/a"],
      exclude: ["/docs/files/**"]
    });
    const items = await listAll(boundary, context);
    expect(items.map((item) => item.id).sort()).toEqual([url("/docs/a"), url("/docs/a/deep")]);
    expect(
      site.requests.slice(before).some((request) => request.path.startsWith("/docs/files"))
    ).toBe(false);
  });

  it("answers the main text as Markdown, without navigation, scripts or the footer", async () => {
    const context = contextFor({ hosts: [site.host] });
    const [item] = await listAll(boundaryOf({ pages: [url("/docs/a")] }), context);
    const text = await fetchText(item, context);
    expect(text).toBe("# Section A\n\n## Rules\n\nAlpha text.\nDeeper");
    expect(item?.size).toBe(Buffer.byteLength(text));
    expect(item?.version).toMatch(/^h[0-9a-f]{40}$/u);
  });

  it("refuses a boundary that names a host its Connection does not list", async () => {
    const context = contextFor({ hosts: [site.host] });
    expect(
      await failureOf(() =>
        listAll(boundaryOf({ pages: [`https://${internal.host}/secret`] }), context)
      )
    ).toBe("unauthorized");
    expect(internal.requests).toEqual([]);
  });
});

describe("what a web source never reaches", () => {
  it("re-checks every redirect: an unlisted host, a listed host the egress list refuses, plain http", async () => {
    site.routes.set("/to-unlisted", (_request, response) => {
      response.writeHead(302, { location: `https://${internal.host}/secret` }).end();
    });
    site.routes.set("/to-plain", (_request, response) => {
      response.writeHead(301, { location: `http://${site.host}/single` }).end();
    });
    site.routes.set("/to-metadata", (_request, response) => {
      response.writeHead(307, { location: "https://169.254.169.254/latest/meta-data" }).end();
    });
    const pages = [url("/to-unlisted"), url("/to-plain"), url("/to-metadata")];
    // The internal server is even listed on this Connection: the egress checker still refuses it,
    // since the operator's list does not name it and it is no public address.
    const context = contextFor({ hosts: [site.host, internal.host, "169.254.169.254"] });
    expect(await listAll(boundaryOf({ pages }), context)).toEqual([]);
    for (const page of pages)
      expect(await failureOf(() => fetchText({ id: page, version: "v" }, context))).not.toBe(
        "answered"
      );
    expect(
      await failureOf(() =>
        fetchText({ id: `https://${internal.host}/secret`, version: "v" }, context)
      )
    ).toBe("unavailable");
    expect(internal.requests).toEqual([]);
  });

  it("follows at most five redirects", async () => {
    for (let hop = 0; hop < 7; hop++)
      site.routes.set(`/loop-${String(hop)}`, (_request, response) => {
        response.writeHead(302, { location: `/loop-${String(hop + 1)}` }).end();
      });
    site.routes.set("/loop-7", html(LAYOUT("<h1>End</h1>")));
    const context = contextFor({ hosts: [site.host] });
    expect(await listAll(boundaryOf({ pages: [url("/loop-0")] }), context)).toEqual([]);
    expect(site.requests.some((request) => request.path === "/loop-7")).toBe(false);
  });

  it("leaves out a page over the size cap and stops a fetch at its cap", async () => {
    site.routes.set(
      "/huge",
      html(`<html><body><p>${"x".repeat(6 * 1024 * 1024)}</p></body></html>`)
    );
    site.routes.set("/files/big.pdf", (_request, response) => {
      response
        .writeHead(200, { "content-type": "application/pdf", etag: '"big"' })
        .end(Buffer.alloc(200_000, 65));
    });
    const context = contextFor({ hosts: [site.host] });
    expect(await listAll(boundaryOf({ pages: [url("/huge")] }), context)).toEqual([]);
    const received: number[] = [];
    const failure = await failureOf(async () => {
      for await (const chunk of source.fetch(
        { itemId: url("/files/big.pdf"), version: "v", maxBytes: 1_000 },
        context
      ))
        received.push(chunk.byteLength);
    });
    expect(failure).toBe("over_limit");
    expect(received.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1_000);
  });

  it("reads one host at most once a second unless the Connection says otherwise", async () => {
    const context = contextFor({ hosts: [site.host], requestsPerSecond: undefined });
    const before = site.requests.length;
    await listAll(boundaryOf({ pages: [url("/single"), url("/b")] }), context);
    const times = site.requests.slice(before).map((request) => request.at);
    expect(times.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < times.length; index++)
      expect((times[index] ?? 0) - (times[index - 1] ?? 0)).toBeGreaterThanOrEqual(900);
  }, 20_000);

  it("keeps everything out where robots.txt names its product token", async () => {
    const other = await startSite();
    other.routes.set("/robots.txt", (_request, response) => {
      response
        .writeHead(200, { "content-type": "text/plain" })
        .end("User-agent: catalyst-knowledge\nDisallow: /\n");
    });
    other.routes.set("/page", html(LAYOUT("<h1>Kept out</h1>")));
    const context = {
      ...contextFor({ hosts: [other.host] }),
      checkEgress: (next: Parameters<ConnectorContext["checkEgress"]>[0]) =>
        createEgressChecker({
          allow: [
            {
              protocol: "https",
              host: "127.0.0.1",
              port: other.port,
              network: "private",
              cidrs: ["127.0.0.1/32"]
            }
          ]
        }).check(next)
    };
    expect(await listAll(boundaryOf({ pages: [`https://${other.host}/page`] }), context)).toEqual(
      []
    );
    expect(other.requests.map((request) => request.path)).toEqual(["/robots.txt"]);
    await new Promise<void>((resolve) => other.server.close(() => resolve()));
  });
});

describe("the changes of a web source", () => {
  it("settles each poll, revalidates with conditional requests, and answers what changed or went", async () => {
    let version = 1;
    site.routes.set("/live", (request, response) => {
      if (request.headers["if-none-match"] === `"live-${String(version)}"`) {
        response.writeHead(304).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "text/html", etag: `"live-${String(version)}"` })
        .end(LAYOUT(`<h1>Live</h1><p>Version ${String(version)}</p>`));
    });
    site.routes.set("/going", html(LAYOUT("<h1>Going</h1>")));
    const context = contextFor({ hosts: [site.host] });
    const boundary = boundaryOf({ pages: [url("/live"), url("/going")] });
    await listAll(boundary, context);
    const start = await source.changes({ boundary }, context);
    if (start.kind !== "changes") throw new Error("A web source offers a change feed");
    expect(start.changes).toEqual([]);

    const drain = async (cursor: string) => {
      const changes: DocumentSourceChange[] = [];
      for (let calls = 0; calls < 20; calls++) {
        const page = await source.changes({ boundary, cursor }, context);
        if (page.kind !== "changes") throw new Error("A web source offers a change feed");
        changes.push(...page.changes);
        if (page.changes.length === 0 && page.nextCursor === cursor) return { changes, cursor };
        cursor = page.nextCursor;
      }
      throw new Error("The feed never settled");
    };

    // The poll that just began settles: no request at all.
    const quiet = site.requests.length;
    expect((await drain(start.nextCursor)).changes).toEqual([]);
    expect(site.requests.length).toBe(quiet);

    // The next poll, nothing changed: one conditional request per page, and no change.
    clock += 3 * 60_000;
    const unchanged = await drain(start.nextCursor);
    expect(unchanged.changes).toEqual([]);
    const live = site.requests.filter((request) => request.path === "/live").at(-1);
    expect(live?.headers["if-none-match"]).toBe('"live-1"');

    // Another poll: one page changed, the other is gone.
    version = 2;
    site.routes.delete("/going");
    clock += 3 * 60_000;
    const after = await drain(unchanged.cursor);
    expect(after.changes).toEqual([
      expect.objectContaining({
        kind: "upsert",
        item: expect.objectContaining({ id: url("/live") })
      }),
      { kind: "delete", item: { id: url("/going") } }
    ]);
  });

  it("refuses a position of another boundary, so the sync lists again", async () => {
    const context = contextFor({ hosts: [site.host] });
    const first = await source.changes(
      { boundary: boundaryOf({ pages: [url("/single")] }) },
      context
    );
    if (first.kind !== "changes") throw new Error("A web source offers a change feed");
    expect(
      await failureOf(() =>
        source.changes(
          { boundary: boundaryOf({ pages: [url("/b")] }), cursor: first.nextCursor },
          context
        )
      )
    ).toBe("cursor_expired");
  });
});

describe("sitemaps", () => {
  it("lists the pages a sitemap names on listed hosts, with its lastmod where the page states no date", async () => {
    site.routes.set("/sitemap.xml", (_request, response) => {
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end(
          `<?xml version="1.0"?><urlset><url><loc>${url("/b")}</loc><lastmod>2026-10-05</lastmod></url><url><loc>https://${internal.host}/secret</loc></url><url><loc>${url("/docs/private/x")}</loc></url></urlset>`
        );
    });
    const context = contextFor({ hosts: [site.host] });
    const items = await listAll(boundaryOf({ sitemaps: [url("/sitemap.xml")] }), context);
    expect(items).toEqual([
      expect.objectContaining({
        id: url("/b"),
        parents: [url("/sitemap.xml")],
        modifiedAt: "2026-10-05T00:00:00.000Z"
      })
    ]);
    expect(internal.requests).toEqual([]);
  });
});
