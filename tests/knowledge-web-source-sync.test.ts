import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEgressChecker,
  createWebConnectorType,
  sourceHttpTransport
} from "@work-shape/catalyst-connections";
import { KNOWLEDGE_BASE_ASSET_KIND, type ConnectorContext } from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";

// A web source (KB-WEB) through the sync engine: published with addresses instead of folders,
// listed, fetched as Markdown, indexed and found by a search whose passage links the page and
// carries the date it states. The site is a fake one on 127.0.0.1, served over plain HTTP to the
// real pinned transport; the egress checker admits it as a private entry.

let server: Server;
let host = "";
let stand = "01.11.2026";

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/robots.txt") {
      response.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
      return;
    }
    if (request.url === "/law/") {
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          `<html><head><title>Law index</title></head><body><nav><a href="/law/s7">Section 7</a></nav><main><h1>Law index</h1><a href="/law/s7">Section 7</a></main></body></html>`
        );
      return;
    }
    if (request.url === "/law/s7") {
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          `<html><head><title>Section 7 Depreciation</title></head><body><main><h1>Section 7 Depreciation</h1><p>Stand: ${stand}</p><p>Wear and tear of buildings is deducted at two percent a year.</p></main></body></html>`
        );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The site has no port.");
  host = `127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a web source through the sync engine", () => {
  const { setup } = useKnowledgeSync();

  it("syncs a prefix and answers a search with the page's link and date", async () => {
    const port = Number(host.split(":")[1]);
    const checker = createEgressChecker({
      allow: [
        { protocol: "https", host: "127.0.0.1", port, network: "private", cidrs: ["127.0.0.1/32"] }
      ]
    });
    const web = createWebConnectorType({
      transport: (input) =>
        sourceHttpTransport({ ...input, grant: { ...input.grant, protocol: "http" } })
    }).documentSource;
    if (web === undefined) throw new Error("The web type has no document source.");
    // The fixture Connection of the harness, read as a web Connection listing the fake site.
    const asWeb = (context: ConnectorContext): ConnectorContext => ({
      ...context,
      connection: {
        ...context.connection,
        id: "web-sync",
        settings: { hosts: [host], requestsPerSecond: 10 }
      },
      // The fake site on 127.0.0.1 plays a public host: a web source refuses a private grant.
      checkEgress: async (target) => ({ ...(await checker.check(target)), network: "public" })
    });
    const world = await setup(() => ({
      list: (input, context) => web.list(input, asWeb(context)),
      changes: (input, context) => web.changes(input, asWeb(context)),
      fetch: (input, context) => web.fetch(input, asWeb(context))
    }));
    await world.publishSources([
      { id: "source", connection: "fixture", prefixes: [`https://${host}/law/`] }
    ]);
    await world.drain(await world.sync("full"));

    const items =
      await world.sql`select item_id, name, mime, path, origin_link, modified_at, stated_at from catalyst_kb.source_items order by item_id`;
    expect(items).toMatchObject([
      {
        item_id: `https://${host}/law/`,
        name: "Law index",
        mime: "text/markdown",
        path: "/law/",
        // The index states no date of its own, so it has none to cite as its "Stand".
        stated_at: null
      },
      {
        item_id: `https://${host}/law/s7`,
        name: "Section 7 Depreciation",
        origin_link: `https://${host}/law/s7`
      }
    ]);
    expect(items[1]?.modified_at).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(items[1]?.stated_at).toEqual(new Date("2026-11-01T00:00:00.000Z"));

    const search = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: "sync-test" },
      payload: { query: "wear and tear of buildings" }
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json()).toMatchObject({
      passages: expect.arrayContaining([
        expect.objectContaining({
          originLink: `https://${host}/law/s7`,
          fileName: "Section 7 Depreciation",
          statedAt: "2026-11-01T00:00:00Z",
          retrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
          text: expect.stringContaining("two percent a year")
        })
      ])
    });

    // A new "Stand" is a new version of the page, read again by the next pass.
    stand = "05.11.2026";
    await world.drain(await world.sync("full"));
    const [changed] =
      await world.sql`select modified_at, stated_at from catalyst_kb.source_items where item_id = ${`https://${host}/law/s7`}`;
    expect(changed?.modified_at).toEqual(new Date("2026-11-05T00:00:00.000Z"));
    expect(changed?.stated_at).toEqual(new Date("2026-11-05T00:00:00.000Z"));
  }, 120_000);

  it("refuses a source that names folders and addresses, neither, or an address it may not hold", async () => {
    const world = await setup();
    const current = required(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: "sync-test"
      })
    );
    const put = (source: Record<string, unknown>) =>
      world.instance.api.call("assets.put", {
        params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: "sync-test" },
        payload: {
          config: {
            ...required(current.config),
            sources: [{ id: "web", connection: "fixture", ...source }]
          },
          expectedRevision: current.revision
        }
      });
    const page = "https://www.example.org/a";
    for (const refused of [
      { folders: ["1"], pages: [page] },
      {},
      { pages: ["http://www.example.org/a"] },
      { pages: ["https://user@www.example.org/a"] },
      { pages: [`${page}#top`] },
      { pages: [page], prefixes: [page] },
      { folders: ["1"], maxDepth: 2 },
      { prefixes: ["https://www.example.org/"], maxDepth: 11 }
    ]) {
      const answer = await put(refused);
      expect(answer.statusCode, JSON.stringify(refused)).toBe(422);
    }
    const taken = await put({
      pages: [page],
      sitemaps: ["https://www.example.org/sitemap.xml"],
      maxDepth: 2
    });
    expect(taken.statusCode, taken.body).toBe(200);
  }, 120_000);
});
