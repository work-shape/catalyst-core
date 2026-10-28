import { z } from "zod";
import { createContentForwarder } from "./registration";
import { watchRendererMemory } from "./registration";
import { chromium, type Browser, type BrowserContext } from "playwright";
import sharp from "sharp";
import { rendererSandboxEvidence, type SandboxEvidence } from "./sandbox";
import {
  CAPTURE_MS,
  IDLE_MS,
  MAX_IMAGE_BYTES,
  RECYCLE_AFTER,
  VIEWPORTS,
  type CaptureInput,
  type CaptureOutcome,
  type BlockedRequest
} from "./protocol";

interface ProcessInfo {
  id: number;
  type: string;
}

export class CaptureRenderer {
  private browser: Browser | undefined;
  private starting: Promise<Browser> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private captures = 0;
  private active = 0;
  private browserPid: number | undefined;
  constructor(
    private readonly options: { apiOrigin: string; interfaceOrigin: string; hostScript: string }
  ) {}

  private async processes(browser: Browser): Promise<ProcessInfo[]> {
    const cdp = await browser.newBrowserCDPSession();
    try {
      return z
        .object({ processInfo: z.array(z.object({ id: z.number(), type: z.string() })) })
        .parse(await cdp.send("SystemInfo.getProcessInfo")).processInfo;
    } finally {
      await cdp.detach();
    }
  }
  private async start(): Promise<Browser> {
    if (this.idle) clearTimeout(this.idle);
    if (this.browser?.isConnected()) return this.browser;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // Playwright disables this sandbox by default. Never accept caller-supplied launch flags.
      const browser = await chromium.launch({
        chromiumSandbox: true,
        headless: true,
        timeout: 10_000,
        env: { HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
        args: ["--js-flags=--max-old-space-size=128"]
      });
      this.browser = browser;
      this.browserPid = (await this.processes(browser)).find((p) => p.type === "browser")?.id;
      browser.on("disconnected", () => {
        if (this.browser === browser) this.browser = undefined;
      });
      return browser;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /** A startup probe, closed afterwards: no untrusted page runs before this passes. */
  async verifySandbox(): Promise<SandboxEvidence> {
    if (process.platform !== "linux" || process.getuid?.() === 0)
      throw new Error("preview-capture requires non-root Linux with a renderer sandbox");
    try {
      const browser = await this.start();
      const page = await browser.newPage();
      await page.goto("data:text/html,<p>Sandbox probe</p>");
      const processes = await this.processes(browser);
      const renderer = processes.find((p) => p.type === "renderer");
      if (!this.browserPid || !renderer) throw new Error("No sandboxed renderer");
      return await rendererSandboxEvidence(this.browserPid, renderer.id);
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    const browser = this.browser;
    this.browser = undefined;
    // A stuck renderer must not keep shutdown or the next capture waiting indefinitely.
    const pid = this.browserPid;
    const kill = setTimeout(() => {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
    }, 500);
    try {
      await browser?.close();
    } finally {
      clearTimeout(kill);
    }
  }

  async capture(input: CaptureInput): Promise<CaptureOutcome> {
    const remaining = Math.min(CAPTURE_MS, input.deadline - Date.now());
    if (remaining <= 0) return { status: "refused", code: "capture_failed" };
    this.active++;
    let context: BrowserContext | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopMonitor: (() => void) | undefined;
    let memoryExceeded = false;
    const blocked: BlockedRequest[] = [];
    const record = (method: string, raw: string) => {
      if (blocked.length >= 50) return;
      const url = new URL(raw);
      // No content token, query, userinfo or fragment may become a diagnostic.
      const path = url.pathname.replace(/(\/app-content\/[^/]+\/)[^/]+/gu, "$1…").slice(0, 240);
      const entry = { method: method.slice(0, 16), host: url.host.slice(0, 160), path };
      const sameAddress = (kept: BlockedRequest) =>
        kept.host === entry.host && kept.path === entry.path;
      if (method === "CSP" && blocked.some(sameAddress)) return;
      if (method !== "CSP") {
        const csp = blocked.findIndex((kept) => kept.method === "CSP" && sameAddress(kept));
        if (csp >= 0) blocked.splice(csp, 1);
      }
      if (
        !blocked.some(
          (kept) =>
            kept.method === entry.method && kept.host === entry.host && kept.path === entry.path
        )
      )
        blocked.push(entry);
    };
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          this.close().catch(() => undefined);
          reject(new Error("deadline"));
        }, remaining);
      });
      return await Promise.race([
        timedOut,
        (async (): Promise<CaptureOutcome> => {
          const browser = await this.start();
          context = await browser.newContext({
            acceptDownloads: false,
            serviceWorkers: "block",
            viewport: VIEWPORTS[input.size],
            deviceScaleFactor: 1,
            colorScheme: input.theme,
            locale: input.locale
          });
          const ctx = context;
          // CSP can reject before routing. These failures still belong in the service's report.
          ctx.on("requestfailed", (request) => {
            record(request.method(), request.url());
          });
          stopMonitor = watchRendererMemory(
            async () =>
              (await this.processes(browser)).filter((p) => p.type === "renderer").map((p) => p.id),
            () => {
              memoryExceeded = true;
            }
          );
          const hostUrl = `${this.options.interfaceOrigin}/__preview_capture_host__`;
          const address = new URL(input.contentPath, this.options.interfaceOrigin).href;
          const contextInput = {
            address,
            session: input.session,
            context: {
              viewer: { kind: "member", id: "", displayName: "" },
              workspace: null,
              locale: input.locale,
              theme: input.themeColors,
              mode: input.theme,
              pageId: "",
              fileSetNumber: input.number,
              initialRoute: "/",
              can: {}
            }
          };
          const json = JSON.stringify(contextInput).replaceAll("<", "\\u003c");
          const host = `<!doctype html><html><head><style>html,body{margin:0}</style></head><body><script>window.captureInput=${json}</script><script>${this.options.hostScript}</script></body></html>`;
          const forward = createContentForwarder({
            ...this.options,
            prefix: input.contentPath,
            locale: input.locale,
            deadline: input.deadline
          });
          await ctx.routeWebSocket("**/*", (socket) => {
            record("WEBSOCKET", socket.url());
            socket.close().catch(() => undefined);
          });
          let hostServed = false;
          await ctx.route("**/*", async (route) => {
            const request = route.request();
            if (
              !hostServed &&
              request.method() === "GET" &&
              request.url() === hostUrl &&
              request.isNavigationRequest()
            ) {
              hostServed = true;
              await route.fulfill({ contentType: "text/html", body: host });
              return;
            }
            try {
              const response = await forward(
                request.method(),
                request.url(),
                await request.allHeaders()
              );
              if (response) {
                await route.fulfill(response);
                return;
              }
            } catch {
              /* Fail closed; a content service failure is a blocked request. */
            }
            record(request.method(), request.url());
            await route.abort("blockedbyclient");
          });
          const page = await ctx.newPage();
          // A policy may refuse before Chromium creates an HTTP request. DevTools reports
          // its full blocked URL, whereas the page's policy event can reveal only an origin.
          const audits = await ctx.newCDPSession(page);
          await audits.send("Audits.enable");
          audits.on("Audits.issueAdded", (event) => {
            const parsed = z
              .object({
                issue: z.object({
                  details: z.object({
                    contentSecurityPolicyIssueDetails: z
                      .object({ blockedURL: z.string().optional(), isReportOnly: z.boolean() })
                      .optional()
                  })
                })
              })
              .safeParse(event);
            const policy = parsed.success
              ? parsed.data.issue.details.contentSecurityPolicyIssueDetails
              : undefined;
            if (
              policy &&
              !policy.isReportOnly &&
              policy.blockedURL &&
              /^https?:/u.test(policy.blockedURL)
            )
              record("CSP", policy.blockedURL);
          });
          page.on("dialog", (dialog) => {
            dialog.dismiss().catch(() => undefined);
          });
          page.on("download", (download) => {
            download.cancel().catch(() => undefined);
          });
          ctx.on("page", (popup) => {
            if (popup !== page) popup.close().catch(() => undefined);
          });
          await page.goto(hostUrl, { waitUntil: "load", timeout: Math.min(8000, remaining) });
          await page
            .waitForFunction("window.captureReport?.settled === true", undefined, { timeout: 8000 })
            .catch(() => undefined);
          const inner = page
            .frames()
            .find((frame) => frame.parentFrame()?.parentFrame() === page.mainFrame());
          const contentHeight = await inner?.evaluate(() =>
            Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
          );
          const height = Math.min(1600, Math.max(VIEWPORTS[input.size].height, contentHeight ?? 0));
          await page.locator("iframe").evaluate((frame, height) => {
            frame.style.height = `${height}px`;
          }, height);
          await page.setViewportSize({ width: VIEWPORTS[input.size].width, height });
          const png = await page.screenshot({
            type: "png",
            animations: "disabled",
            timeout: Math.max(1, input.deadline - Date.now())
          });
          let image = await sharp(png).webp({ quality: 80 }).toBuffer();
          for (const quality of [60, 40, 20]) {
            if (image.length <= MAX_IMAGE_BYTES) break;
            image = await sharp(png).webp({ quality }).toBuffer();
          }
          if (image.length > MAX_IMAGE_BYTES || memoryExceeded) throw new Error("image bound");
          const diagnostics = z
            .object({
              report: z.unknown(),
              calls: z.array(z.object({ name: z.string(), code: z.string() })).max(20)
            })
            .parse(
              await page.evaluate("({ report: window.captureReport, calls: window.captureCalls })")
            );
          if (!diagnostics.report) throw new Error("No guard report");
          return {
            status: "done",
            image: image.toString("base64"),
            report: diagnostics.report,
            calls: diagnostics.calls,
            blocked
          };
        })()
      ]);
    } catch {
      return {
        status: "refused",
        code: "capture_failed",
        ...(memoryExceeded ? { message: "The page used too much memory" } : {})
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      stopMonitor?.();
      // close() above kills a browser on deadline. Normal cleanup closes only this context.
      await context?.close().catch(() => undefined);
      this.active--;
      this.captures++;
      if (this.active === 0) {
        if (this.captures >= RECYCLE_AFTER) {
          this.captures = 0;
          await this.close();
        } else {
          this.idle = setTimeout(() => {
            this.close().catch(() => undefined);
          }, IDLE_MS);
          this.idle.unref();
        }
      }
    }
  }
}
