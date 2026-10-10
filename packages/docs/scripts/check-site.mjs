// Serves the built host root (`dist/`) on a local port the way the static host does and crawls
// it from the base path. It fails when a link, an asset, an anchor, a sitemap entry or the
// search index does not resolve under the base, or when the old root paths would be served.
import { createServer, request } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://docs.workshape.ai";
const BASE = "/catalyst/";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const types = { ".html": "text/html", ".xml": "application/xml", ".txt": "text/plain" };

/** The file a path is answered with: the file itself or the index page of its folder. */
function fileFor(pathname) {
  const path = join(root, decodeURIComponent(pathname));
  if (!path.startsWith(root)) return undefined;
  if (existsSync(path) && statSync(path).isFile()) return path;
  const index = join(path, "index.html");
  return pathname.endsWith("/") && existsSync(index) ? index : undefined;
}

/** The 404 page nearest to a path, going up the folders, as the static host picks it. */
function notFoundFor(pathname) {
  for (
    let folder = dirname(join(root, pathname));
    folder.startsWith(root);
    folder = dirname(folder)
  ) {
    if (existsSync(join(folder, "404.html"))) return join(folder, "404.html");
  }
  return join(root, "404.html");
}

const server = createServer((incoming, response) => {
  const { pathname } = new URL(incoming.url, "http://localhost");
  const file = fileFor(pathname);
  const served = file ?? notFoundFor(pathname);
  response.writeHead(file ? 200 : 404, {
    "content-type": types[extname(served)] ?? "application/octet-stream"
  });
  response.end(readFileSync(served));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const problems = [];
const pages = new Map(); // pathname -> html
const assets = new Set();
const queue = [BASE];
const references = []; // { from, url }

function get(pathname) {
  return new Promise((done, failed) => {
    request(origin + pathname, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        done({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") })
      );
    })
      .on("error", failed)
      .end();
  });
}

while (queue.length > 0) {
  const pathname = queue.pop();
  if (pages.has(pathname)) continue;
  const { status, body } = await get(pathname);
  if (status !== 200) {
    pages.set(pathname, "");
    continue; // reported through the reference that led here
  }
  pages.set(pathname, body);
  for (const [, , value] of body.matchAll(/\s(href|src)="([^"]*)"/gu)) {
    // A link to the public address, such as the canonical link, is followed on the local server.
    const target = value.replaceAll("&amp;", "&");
    const url = new URL(
      target.startsWith(SITE) ? target.slice(SITE.length) : target,
      origin + pathname
    );
    if (url.origin !== origin) continue;
    references.push({ from: pathname, url });
    if (!url.pathname.startsWith(BASE)) {
      problems.push(`${pathname}: ${value} leaves the base path`);
    } else if (extname(url.pathname) === "" || url.pathname.endsWith(".html")) {
      queue.push(url.pathname);
    } else {
      assets.add(url.pathname);
    }
  }
}

for (const asset of assets) {
  if ((await get(asset)).status !== 200) problems.push(`missing asset ${asset}`);
}
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map(([, id]) => id));
for (const { from, url } of references) {
  const html = pages.get(url.pathname);
  if (html === undefined) continue; // an asset, checked above
  if (html === "") problems.push(`${from}: broken link to ${url.pathname}`);
  else if (url.hash.length > 1 && !ids(html).has(decodeURIComponent(url.hash.slice(1)))) {
    problems.push(`${from}: no anchor ${url.hash} on ${url.pathname}`);
  }
}

// The sitemap names every page under the public address and nothing else.
const locations = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, loc]) => loc);
const sitemapPages = [];
for (const sitemap of locations((await get(`${BASE}sitemap-index.xml`)).body)) {
  if (!sitemap.startsWith(SITE + BASE))
    problems.push(`sitemap index entry outside the base: ${sitemap}`);
  sitemapPages.push(...locations((await get(new URL(sitemap).pathname)).body));
}
for (const location of sitemapPages) {
  const pathname = location.startsWith(SITE) ? location.slice(SITE.length) : undefined;
  if (pathname === undefined || !pathname.startsWith(BASE))
    problems.push(`sitemap entry outside the base: ${location}`);
  else if ((await get(pathname)).status !== 200)
    problems.push(`sitemap entry without a page: ${location}`);
}
const crawled = [...pages].filter(([, html]) => html !== "").map(([pathname]) => pathname);
for (const pathname of crawled) {
  if (!sitemapPages.includes(SITE + pathname))
    problems.push(`page missing in the sitemap: ${pathname}`);
}
const robots = (await get("/robots.txt")).body;
if (!robots.includes(`Sitemap: ${SITE}${BASE}sitemap-index.xml`))
  problems.push("robots.txt does not name the sitemap");

// The search index: its entry file answers under the base and holds one fragment per page.
const fragments = existsSync(join(root, BASE, "pagefind/fragment"))
  ? readdirSync(join(root, BASE, "pagefind/fragment")).length
  : 0;
if ((await get(`${BASE}pagefind/pagefind.js`)).status !== 200)
  problems.push("the search index is not under the base");
if (fragments !== crawled.length)
  problems.push(`search index holds ${fragments} pages, the site ${crawled.length}`);

// A missing page under the base gets the site's own 404 page, and nothing is served at the old root paths.
const missing = await get(`${BASE}no-such-page/`);
if (missing.status !== 404 || !missing.body.includes("<title>404"))
  problems.push("a missing page does not answer with the site's 404 page");
if (fileFor("/getting-started/overview/"))
  problems.push("pages are also built at the root of the host");

server.close();
console.log(
  `[docs] crawled ${crawled.length} pages, ${assets.size} assets, ${references.length} links, ${sitemapPages.length} sitemap entries, ${fragments} search fragments`
);
console.log(`[docs] broken: ${problems.length}`);
for (const problem of [...new Set(problems)]) console.error(`  ${problem}`);
process.exit(problems.length === 0 ? 0 : 1);
