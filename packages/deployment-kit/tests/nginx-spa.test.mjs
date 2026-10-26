// The interface image's nginx configuration, run in the image's own nginx: what a browser gets
// with the interface. Needs Docker. `pnpm test:deployment-kit`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { get as httpGet } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const kitDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const image = /^FROM (nginx:\S+) AS ui$/mu.exec(
  readFileSync(join(kitDir, "docker/deployment.Dockerfile"), "utf8")
)?.[1];
const container = `catalyst-nginx-spa-test-${process.pid}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();

/** The status, headers and body of one GET. Node joins a repeated header with a comma. */
const get = (address) =>
  new Promise((resolve, reject) => {
    httpGet(address, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, headers: response.headers, body })
      );
    }).on("error", reject);
  });

describe("the interface's nginx", () => {
  let origin;
  const html = mkdtempSync(join(tmpdir(), "nginx-spa-"));

  before(async () => {
    assert.ok(image, "no ui stage in the Dockerfile");
    writeFileSync(join(html, "index.html"), "<!doctype html><title>Interface</title>");
    mkdirSync(join(html, "assets"));
    writeFileSync(join(html, "assets/main.js"), "");
    docker("create", "--name", container, "--publish", "127.0.0.1::80", image);
    docker(
      "cp",
      join(kitDir, "docker/nginx-spa.conf"),
      `${container}:/etc/nginx/conf.d/default.conf`
    );
    docker("cp", `${html}/.`, `${container}:/usr/share/nginx/html`);
    docker("start", container);
    origin = `http://${docker("port", container, "80/tcp").split("\n")[0]}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await get(origin);
        break;
      } catch (error) {
        if (attempt === 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  after(() => {
    try {
      docker("rm", "--force", container);
    } finally {
      rmSync(html, { recursive: true, force: true });
    }
  });

  test("lets only the interface itself frame the interface", async () => {
    for (const path of ["/", "/index.html", "/c/some-conversation", "/studio/agents/"]) {
      const response = await get(`${origin}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.body, /<title>Interface<\/title>/u, path);
      // One header: a second would come back joined by a comma.
      assert.equal(response.headers["content-security-policy"], "frame-ancestors 'self'", path);
      assert.equal(response.headers["x-frame-options"], "SAMEORIGIN", path);
      assert.equal(response.headers["cache-control"], "no-cache", path);
    }
  });

  test("keeps the cache rule of the built files", async () => {
    const response = await get(`${origin}/assets/main.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
  });

  test("answers no Page address with the interface", async () => {
    const response = await get(`${origin}/app-content/token/index.html`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.body, /<title>Interface<\/title>/u);
  });
});
