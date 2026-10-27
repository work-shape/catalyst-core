// @vitest-environment happy-dom

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  APP_BRIDGE_MARK,
  APP_BRIDGE_VERSION,
  appBridgePageMessageSchema,
  boundPreviewReport,
  previewReportSchema,
  type AppBridgeGuardReport,
  type PreviewReport
} from "@work-shape/catalyst-api-contract";
import { ApiError } from "@work-shape/catalyst-api-client";
import {
  PREVIEW_REPORT_MAX_BYTES,
  scrubPreviewFile,
  scrubPreviewText
} from "@work-shape/catalyst-asset-schemas";
import {
  PREVIEW_GREETING_MS,
  PREVIEW_KEEP_ALIVE_MS,
  PREVIEW_REPORT_INTERVAL_MS,
  PREVIEW_SETTLE_FALLBACK_MS,
  createPreviewReporter
} from "@work-shape/catalyst-chat-ui/pages";
import { PREVIEW_COLLECTOR_SOURCE } from "@work-shape/catalyst-server";

// What a preview reports of itself (PREVIEW-STATUS-1) is diagnostics about a page that shows
// customer data. The guard in the page collects and bounds it, the interface scrubs and bounds
// it before it leaves the browser, and the instance does both again (`app-preview-reports`).

const NAME = "Erika Mustermann-Gabler von Hof"; // 31 characters
const IBAN = "DE89370400440532013000";
const MAIL = "erika.mustermann@example.org";

describe("the scrub of a preview report", () => {
  it("replaces long quoted text, digit runs, mail addresses, IBANs and queries", () => {
    expect(scrubPreviewText(`Kunde "${NAME}" nicht gefunden`)).toBe(`Kunde "…" nicht gefunden`);
    expect(scrubPreviewText(`Kunde „${NAME}“ fehlt`)).toBe("Kunde „…“ fehlt");
    // A short quote is kept: it is a key or a word of the program.
    expect(scrubPreviewText("Cannot read properties of undefined (reading 'map')")).toBe(
      "Cannot read properties of undefined (reading 'map')"
    );
    expect(scrubPreviewText(`IBAN ${IBAN} und DE89 3704 0044 0532 0130 00`)).toBe("IBAN … und …");
    expect(scrubPreviewText(`Mail an ${MAIL} ging nicht`)).toBe("Mail an … ging nicht");
    expect(scrubPreviewText("Rechnung 2026-10-27 über 1.234,50 € für 4711")).toBe(
      "Rechnung … über … € für …"
    );
    expect(scrubPreviewText("Line 12 of 300")).toBe("Line 12 of 300");
    expect(scrubPreviewText("GET https://api.example.org/customers?name=Erika#x failed")).toBe(
      "GET https://api.example.org/customers?… failed"
    );
    // A path's query goes too, and a mail address written with %40 is a mail address.
    expect(scrubPreviewText("GET /api/search?q=Erika+Mustermann 404")).toBe(
      "GET /api/search?… 404"
    );
    expect(scrubPreviewText("no row for erika%40example.de")).toBe("no row for …");
    // The frame's address carries a token that signs the viewer in: it never stays.
    expect(
      scrubPreviewText(
        "Failed to fetch dynamically imported module: https://chat.example.org/app-content/fs_1/eyJ1IjoiYSJ9.c2ln/routes/x.js"
      )
    ).toBe("Failed to fetch dynamically imported module: /routes/x.js");
    // A mail address cut short by a bound is still a mail address.
    expect(scrubPreviewText("to erika.mustermann@exa")).toBe("to …");
    // Kit import names carry an @ and are no mail address.
    expect(scrubPreviewText("Failed to resolve '@scope/app-kit'")).toBe(
      "Failed to resolve '@scope/app-kit'"
    );
  });

  it("keeps at most 200 characters, without control characters, and reads the same twice", () => {
    const long = `${"x".repeat(150)}\n\u0000${"y".repeat(150)}`;
    const once = scrubPreviewText(long);
    expect(Array.from(once)).toHaveLength(200);
    expect(once.endsWith("…")).toBe(true);
    expect(once).not.toMatch(/[\n\u0000]/u);
    for (const text of [once, `Kunde "${NAME}" ${IBAN} ${MAIL} 12345`]) {
      expect(scrubPreviewText(scrubPreviewText(text))).toBe(scrubPreviewText(text));
    }
  });

  it("keeps a file as a path of the page, never the address's origin, token or query", () => {
    expect(
      scrubPreviewFile(
        "https://chat.example.org/app-content/fs_123/eyJ1IjoiYSJ9.c2ln/assets/main-4F3K2J1A.js?v=1"
      )
    ).toBe("assets/main-4F3K2J1A.js");
    expect(scrubPreviewFile("https://chat.example.org/app-runtime/kit/1.8.0/react.js")).toBe(
      "/app-runtime/kit/1.8.0/react.js"
    );
    expect(scrubPreviewFile("about:srcdoc")).toBe("inline");
    expect(scrubPreviewFile(`assets/${MAIL}.js`)).toBeUndefined();
    // A file name is no place for data: a long digit run drops it, a build's hash does not.
    expect(scrubPreviewFile("Erika_Mustermann.4111111111111111.js")).toBeUndefined();
    expect(scrubPreviewFile("assets/chunk-12345678.js")).toBe("assets/chunk-12345678.js");
    expect(scrubPreviewFile("javascript:alert(1)")).toBeUndefined();
    expect(scrubPreviewFile("")).toBeUndefined();
  });
});

describe("the bounds of a preview report", () => {
  const base = { settled: true, loaded: true, bridge: "connected" as const };

  it("lists 10 distinct entries with counts and counts the rest", () => {
    const report = boundPreviewReport({
      ...base,
      entries: Array.from({ length: 14 }, (_, index) => ({
        kind: "console" as const,
        message: `failure ${"abcdefghijklmn".charAt(index)}`,
        count: 2
      })),
      more: 3
    });
    expect(report.entries).toHaveLength(10);
    expect(report.more).toBe(3 + 4 * 2);
    expect(previewReportSchema.safeParse(report).success).toBe(true);
  });

  it("merges entries that read the same once scrubbed", () => {
    const report = boundPreviewReport({
      ...base,
      entries: [
        { kind: "error", message: "Order 1001 failed", count: 1 },
        { kind: "error", message: "Order 1002 failed", count: 4 },
        { kind: "call", message: "save", code: "DATA_STORE_NEEDS_APP", count: 1 },
        { kind: "call", message: "save", code: "data_store_needs_app", count: 2 },
        { kind: "call", message: "load", code: "Not a code!", count: 1 }
      ]
    });
    expect(report.entries).toEqual([
      { kind: "error", message: "Order … failed", count: 5 },
      { kind: "call", message: "save", code: "data_store_needs_app", count: 3 },
      { kind: "call", message: "load", code: "failed", count: 1 }
    ]);
  });

  it("stays under 2 KB, dropping the last entries first and counting them", () => {
    const report = boundPreviewReport({
      ...base,
      entries: Array.from({ length: 10 }, (_, index) => ({
        kind: "error" as const,
        message: `${String.fromCharCode(97 + index)} ${"ü".repeat(250)}`,
        file: "assets/main.js",
        line: index,
        count: 1
      }))
    });
    expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(
      PREVIEW_REPORT_MAX_BYTES
    );
    expect(report.entries.length).toBeLessThan(10);
    expect(report.entries[0]?.line).toBe(0);
    expect(report.more).toBe(10 - report.entries.length);
  });
});

/** The guard's collector in a document of its own, with a clock and timers the test drives. */
function collectorIn(html: string) {
  const window = new Window();
  window.document.write(html);
  const posted: unknown[] = [];
  let clock = 1_000;
  const timers: { at: number; run: () => void }[] = [];
  Object.assign(window, {
    Date: { now: () => clock },
    setTimeout: (run: () => void, ms: number) => {
      timers.push({ at: clock + ms, run });
      return timers.length;
    }
  });
  const host = { postMessage: (message: unknown) => posted.push(message) };
  const collect: unknown = new Function(`return (${PREVIEW_COLLECTOR_SOURCE});`)();
  if (typeof collect !== "function") throw new Error("The collector is not a function");
  Reflect.apply(collect, undefined, [window, host]);
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      clock = next.at;
      next.run();
    }
    clock = until;
  };
  const reports = () =>
    posted.map((message) => {
      const parsed = appBridgePageMessageSchema.parse(message);
      if (parsed.type !== "report") throw new Error(`Not a report: ${parsed.type}`);
      return parsed.report;
    });
  return { window, advance, reports };
}

describe("the guard's collector in a Page", () => {
  it("reports errors, rejections, console errors and policy violations once the page settled", () => {
    const { window, advance, reports } = collectorIn("<body><p>Orders</p></body>");
    window.console.error("Kunde", { name: NAME, iban: IBAN }, [1, 2], "!");
    window.dispatchEvent(
      new window.ErrorEvent("error", {
        message: "Uncaught TypeError: rows.map is not a function",
        filename: "https://chat.example.org/app-content/fs_1/token.mac/assets/main.js",
        lineno: 12
      })
    );
    const rejection = new window.Event("unhandledrejection");
    // An error of the Page's own realm, as a page in a browser throws it.
    Object.assign(rejection, { reason: new window.Error("load failed") });
    window.dispatchEvent(rejection);
    const violation = new window.Event("securitypolicyviolation");
    Object.assign(violation, {
      effectiveDirective: "connect-src",
      blockedURI: "https://api.example.org/customers?name=Erika",
      sourceFile: "https://chat.example.org/app-content/fs_1/token.mac/assets/main.js",
      lineNumber: 40
    });
    window.dispatchEvent(violation);
    window.dispatchEvent(new window.Event("load"));
    advance(1_400);
    expect(reports()).toEqual([]);
    advance(200);
    const [report] = reports();
    expect(report).toEqual({
      settled: true,
      empty: false,
      more: 0,
      entries: [
        { kind: "console", message: "Kunde [Object] [Array] !", count: 1 },
        {
          kind: "error",
          message: "Uncaught TypeError: rows.map is not a function",
          file: "https://chat.example.org/app-content/fs_1/token.mac/assets/main.js",
          line: 12,
          count: 1
        },
        { kind: "rejection", message: "Error: load failed", count: 1 },
        {
          kind: "policy",
          message: "connect-src blocked https://api.example.org",
          file: "https://chat.example.org/app-content/fs_1/token.mac/assets/main.js",
          line: 40,
          count: 1
        }
      ]
    });
  });

  it("counts repeats, keeps 10 entries and reports again a second after a change", () => {
    const { window, advance, reports } = collectorIn("<body><p>Orders</p></body>");
    window.dispatchEvent(new window.Event("load"));
    for (let index = 0; index < 500; index += 1) {
      window.console.error("Kunde", { name: NAME, iban: IBAN });
    }
    for (let index = 0; index < 15; index += 1) window.console.error(`other ${index}`);
    // Each entry restarts the quiet time, at most 8 seconds after load.
    advance(8_000);
    expect(reports()).toHaveLength(1);
    const [first] = reports();
    expect(first?.entries).toHaveLength(10);
    expect(first?.entries[0]).toEqual({ kind: "console", message: "Kunde [Object]", count: 500 });
    expect(first?.more).toBe(6);
    expect(JSON.stringify(first)).not.toContain("Erika");
    window.console.error("Kunde", { name: NAME });
    window.console.error("Kunde", { name: NAME });
    advance(999);
    expect(reports()).toHaveLength(1);
    advance(1);
    expect(reports()[1]?.entries[0]?.count).toBe(502);
  });

  it("reads a page that drew nothing as empty", () => {
    const { window, advance, reports } = collectorIn("<body><div id='root'></div></body>");
    window.dispatchEvent(new window.Event("load"));
    advance(1_500);
    expect(reports()[0]).toEqual({ settled: true, empty: true, entries: [], more: 0 });
  });
});

describe("the interface's report of a preview", () => {
  function reporterWithClock(
    answer: () => Promise<unknown> = () => Promise.resolve(),
    visible: () => boolean = () => true
  ) {
    let clock = 0;
    let becameVisible: (() => void) | undefined;
    const timers = new Map<number, { at: number; run: () => void }>();
    let id = 0;
    const sent: PreviewReport[] = [];
    const reporter = createPreviewReporter(
      (report) => {
        sent.push(report);
        return answer();
      },
      {
        now: () => clock,
        after: (run, ms) => {
          id += 1;
          const own = id;
          timers.set(own, { at: clock + ms, run });
          return () => timers.delete(own);
        },
        visible,
        onVisible: (run) => {
          becameVisible = run;
          return () => {
            becameVisible = undefined;
          };
        }
      }
    );
    const advance = (ms: number) => {
      const until = clock + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        timers.delete(next[0]);
        clock = next[1].at;
        next[1].run();
      }
      clock = until;
    };
    return { reporter, sent, advance, becameVisible: () => becameVisible?.() };
  }
  const guard = (report: Partial<AppBridgeGuardReport> = {}): AppBridgeGuardReport => ({
    settled: true,
    empty: false,
    entries: [],
    more: 0,
    ...report
  });

  it("tells the mount at once, then the settled report with greeting and failed calls", () => {
    const { reporter, sent, advance } = reporterWithClock();
    expect(sent).toEqual([
      { settled: false, loaded: false, bridge: "waiting", entries: [], more: 0 }
    ]);
    reporter.frameLoaded();
    reporter.greeted();
    reporter.callFailed("save", "data_store_needs_app");
    reporter.callFailed("save", "data_store_needs_app");
    reporter.guardReport(
      guard({
        entries: [{ kind: "console", message: `Kunde "${NAME}" ${IBAN} ${MAIL}`, count: 3 }]
      })
    );
    // The settled report follows the mount at once: a run of the agent waits for it.
    advance(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      settled: true,
      loaded: true,
      bridge: "connected",
      empty: false,
      entries: [
        { kind: "console", message: 'Kunde "…" … …', count: 3 },
        { kind: "call", message: "save", code: "data_store_needs_app", count: 2 }
      ],
      more: 0
    });
    // After it, at most one report every 5 seconds.
    reporter.callFailed("load", "forbidden");
    advance(PREVIEW_REPORT_INTERVAL_MS - 1);
    expect(sent).toHaveLength(2);
    advance(1);
    expect(sent).toHaveLength(3);
    expect(sent[2]?.entries.at(-1)).toEqual({
      kind: "call",
      message: "load",
      code: "forbidden",
      count: 1
    });
  });

  it("tells the instance every 30 seconds that a visible preview is still mounted", () => {
    let visible = true;
    const { reporter, sent, advance, becameVisible } = reporterWithClock(undefined, () => visible);
    reporter.frameLoaded();
    reporter.greeted();
    reporter.guardReport(guard());
    advance(0);
    expect(sent).toHaveLength(2);
    advance(PREVIEW_KEEP_ALIVE_MS);
    // The same report again: nothing changed, so a run does not note it twice.
    expect(sent).toHaveLength(3);
    expect(sent[2]).toEqual(sent[1]);
    // A hidden page says nothing; once unmounted, nothing more goes out.
    visible = false;
    advance(PREVIEW_KEEP_ALIVE_MS * 3);
    expect(sent).toHaveLength(3);
    // Back on the page, it is told at once.
    visible = true;
    becameVisible();
    expect(sent).toHaveLength(4);
    reporter.stop();
    advance(PREVIEW_KEEP_ALIVE_MS * 3);
    expect(sent).toHaveLength(4);
  });

  it("says the kit did not greet within 5 seconds, and settles a frame whose guard never did", () => {
    const { reporter, sent, advance } = reporterWithClock();
    reporter.frameLoaded();
    advance(PREVIEW_GREETING_MS);
    // Not settled yet: only the mount was told.
    expect(sent).toHaveLength(1);
    advance(PREVIEW_SETTLE_FALLBACK_MS - PREVIEW_GREETING_MS);
    expect(sent.at(-1)).toMatchObject({ settled: true, loaded: true, bridge: "not_connected" });
    reporter.stop();
    reporter.callFailed("load", "forbidden");
    advance(60_000);
    expect(sent).toHaveLength(2);
  });

  it("waits 5 seconds for the greeting from the guard's first report too", () => {
    const { reporter, sent, advance } = reporterWithClock();
    // The frame's load event was missed: the guard's report says the document loaded.
    reporter.guardReport(guard());
    advance(PREVIEW_GREETING_MS);
    expect(sent.at(-1)).toMatchObject({ loaded: true, bridge: "not_connected" });
  });

  it("stops once the instance no longer knows the frame's address", async () => {
    const { reporter, sent, advance } = reporterWithClock(() =>
      Promise.reject(new ApiError(404, "Not found", undefined))
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    reporter.guardReport(guard());
    advance(60_000);
    expect(sent).toHaveLength(1);
  });

  it("posts what the guard reports as a bridge message from the frame", () => {
    const message = {
      [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
      type: "report",
      report: guard()
    };
    expect(appBridgePageMessageSchema.parse(message)).toEqual(message);
    // A guard report longer than the interface takes is no report.
    expect(
      appBridgePageMessageSchema.safeParse({
        ...message,
        report: guard({ entries: [{ kind: "error", message: "x".repeat(1001), count: 1 }] })
      }).success
    ).toBe(false);
  });
});
