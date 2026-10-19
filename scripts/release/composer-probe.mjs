// The fresh consumer's built UI, in a real browser: sign in, open the workspace start page
// and type in the composer. A chat runtime that loops ("Maximum update depth exceeded", as
// @assistant-ui/react 0.14.29 with tap 0.9.23 did) throws here even when every HTTP probe passes.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPED = "Hallo";
const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1_500;
const COMPOSER = /^(Message|Nachricht)$/u;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm"
};

/** Serves a Vite build like the deployments' nginx: files as they are, every route the SPA. */
export async function serveBuiltUi(dir, port) {
  const root = normalize(dir);
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://ui").pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(root, "index.html");
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream"
    });
    response.end(readFileSync(file));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return () => new Promise((resolve) => server.close(resolve));
}

/**
 * Makes one agent available so the start page shows its composer: an API key straight into
 * the throwaway database, then the consumer's own `catalyst config push`.
 */
export function pushSmokeAgent(consumer, baseUrl, configPath, env) {
  const assets = join(consumer, "smoke-config-assets");
  mkdirSync(join(assets, "agents"), { recursive: true });
  writeFileSync(
    join(assets, "catalyst.yaml"),
    JSON.stringify({
      instances: { smoke: { url: baseUrl } },
      defaultInstance: "smoke",
      defaultAgentName: "release_smoke",
      agents: ["agents/*.agent.yaml"],
      skills: []
    })
  );
  writeFileSync(
    join(assets, "agents", "release-smoke.agent.yaml"),
    JSON.stringify({
      name: "release_smoke",
      displayName: { de: "Release-Smoke", en: "Release smoke" },
      description: { de: "Prüft den Composer.", en: "Checks the composer." },
      modelBindingId: "primary",
      instructions: "Answer briefly."
    })
  );
  const keyFile = join(consumer, "smoke-key.env");
  writeFileSync(keyFile, "");
  const run = (args, extra = {}) =>
    execFileSync(process.execPath, args, {
      cwd: consumer,
      env: { ...env, ...extra },
      stdio: ["ignore", "inherit", "inherit"]
    });
  run([
    "node_modules/@work-shape/catalyst-client-assembly/dist/local-key-cli.js",
    "--instance",
    baseUrl,
    "--config",
    configPath,
    "--write-env",
    keyFile,
    "--env-name",
    "CATALYST_API_KEY"
  ]);
  const key = readFileSync(keyFile, "utf8").match(/^CATALYST_API_KEY=(.+)$/mu)?.[1];
  if (!key) throw new Error("fresh-resolution: the local key command wrote no API key");
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${key}`);
  const cli = join(consumer, "node_modules/@work-shape/catalyst-cli");
  const { bin } = JSON.parse(readFileSync(join(cli, "package.json"), "utf8"));
  run(
    [join(cli, typeof bin === "string" ? bin : bin.catalyst), "config", "push", "--dir", assets],
    { CATALYST_API_KEY: key }
  );
}

/** Returns the page errors met while signing in, opening the start page and typing. */
export async function typeInComposer(uiOrigin, email, password, browserType) {
  const chromium = browserType ?? (await import("@playwright/test")).chromium;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /Maximum update depth/u.test(message.text())) {
        errors.push(message.text().split("\n")[0]);
      }
    });
    await page.goto(uiOrigin, { timeout: NAVIGATION_TIMEOUT_MS });
    await page.locator('input[type="email"]').fill(email, { timeout: NAVIGATION_TIMEOUT_MS });
    await page.locator('input[type="password"]').fill(password);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/w\/[^/]+\/?$/u, { timeout: NAVIGATION_TIMEOUT_MS });
    const composer = page.getByRole("textbox", { name: COMPOSER });
    await composer.click({ timeout: NAVIGATION_TIMEOUT_MS });
    await page.keyboard.type(TYPED, { delay: 50 });
    await page.waitForTimeout(SETTLE_MS);
    if (!(await composer.isVisible())) errors.push("the composer disappeared while typing");
    else if ((await composer.inputValue()) !== TYPED) {
      errors.push(`the composer holds "${await composer.inputValue()}", not "${TYPED}"`);
    }
  } finally {
    await browser.close();
  }
  return errors;
}
