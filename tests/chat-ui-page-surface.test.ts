import { createElement, type ReactNode } from "react";
import {
  APP_BRIDGE_MARK,
  APP_BRIDGE_VERSION,
  appBridgeHostMessageSchema,
  type AppBridgeContext
} from "@work-shape/catalyst-api-contract";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  changedSourcePaths,
  contextMessage,
  createPageBridge,
  defaultOpenPath,
  PageBuildErrors,
  PageFilesView,
  pageFrameAddress,
  PageSaveCardView,
  pageBuildingSurface,
  pageSurface,
  pageSurfaceAfterRunCalls,
  PageSurfaceView,
  PreviewPane,
  readPageMessage,
  readPageSave,
  themeMessage,
  type ArrivedMessage,
  type PageSave
} from "@work-shape/catalyst-chat-ui/pages";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// What an agent opens shows beside the conversation. These tests hold the rules of that
// surface: what a `workspace.open` call, or one of its former name `page.save`, asks of the slot, which messages of a frame the interface
// listens to, and what each state of the surface shows.
// Every test here fails without the Page surface: the modules it reads did not exist.

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const built = { output: { pageId: "page-1", number: 2, fileSetId: "set-2" } };
const refused = {
  output: {
    errors: [
      { file: "src/routes/index.tsx", line: 12, column: 3, message: "Expected '}'" },
      { file: "app.yaml", message: "The kit version '9.9.9' is not released." }
    ]
  }
};

describe("a call of workspace.open", () => {
  it("is a build while it has no answer, a revision when it stored one", () => {
    expect(readPageSave({ args: { path: " Offers " }, result: undefined })).toEqual({
      state: "building",
      name: "Offers"
    });
    expect(readPageSave({ args: { name: "Offers" }, result: built })).toEqual({
      state: "built",
      name: "Offers",
      pageId: "page-1",
      fileSetId: "set-2",
      number: 2
    });
    // An answer that is the output itself reads the same.
    expect(readPageSave({ args: {}, result: built.output })).toMatchObject({
      state: "built",
      name: undefined
    });
  });

  it("keeps file, line and message of what the build found and nothing else", () => {
    expect(readPageSave({ args: { name: "Offers" }, result: refused })).toEqual({
      state: "errors",
      name: "Offers",
      errors: [
        { file: "src/routes/index.tsx", line: 12, message: "Expected '}'" },
        { file: "app.yaml", message: "The kit version '9.9.9' is not released." }
      ]
    });
  });

  it("is a failed save when the call failed or answered neither", () => {
    expect(readPageSave({ args: { name: "Offers" }, result: built, failed: true }).state).toBe(
      "failed"
    );
    expect(readPageSave({ args: {}, result: { output: { pageId: "page-1" } } }).state).toBe(
      "failed"
    );
    expect(readPageSave({ args: {}, result: "no" }).state).toBe("failed");
  });

  it("opens as a surface of exactly that revision, named after the Page, with no revision number", () => {
    const save = readPageSave({ args: { name: "Offers" }, result: built });
    if (save.state !== "built") {
      throw new Error("expected a revision");
    }

    expect(pageSurface("conv-1", save, t)).toEqual({
      kind: "page",
      key: "page:page-1:set-2",
      title: "Offers",
      path: "Offers",
      conversationId: "conv-1",
      pageId: "page-1",
      fileSetId: "set-2"
    });
    expect(pageSurface("conv-1", { ...save, name: undefined }, de).title).toBe("Vorschau");
  });
});

describe("the calls of a run and the surface slot", () => {
  const call = (toolCallId: string, state: string, output?: unknown, name = "Offers") => ({
    type: "tool_call",
    toolCallId,
    toolName: "workspace.open",
    input: { path: name },
    state,
    output
  });
  const ask = (
    parts: Parameters<typeof pageSurfaceAfterRunCalls>[0]["parts"],
    handled = new Set<string>(),
    current?: ReturnType<typeof pageSurface>
  ) =>
    pageSurfaceAfterRunCalls({
      conversationId: "conv-1",
      parts,
      handled,
      current,
      t
    });

  it("opens the revision a call stored, once per call", () => {
    const handled = new Set<string>();
    const parts = [call("call-1", "output_available", built)];

    expect(ask(parts, handled)).toMatchObject({ key: "page:page-1:set-2", title: "Offers" });
    expect(ask([call("call-2", "output_available", built)], handled)).not.toHaveProperty(
      "subtitle"
    );
    expect(ask(parts, handled)).toBeUndefined();
  });

  it("opens the building Page once when a call starts, and the newest of several revisions", () => {
    const handled = new Set<string>();
    const third = { output: { pageId: "page-1", number: 3, fileSetId: "set-3" } };

    expect(ask([call("call-1", "input_available")], handled)).toEqual({
      kind: "page_building",
      key: "page-building:call-1",
      title: "Offers",
      callId: "call-1"
    });
    expect(ask([call("call-1", "input_available")], handled)).toBeUndefined();
    expect(
      ask(
        [call("call-1", "output_available", built), call("call-2", "output_available", third)],
        handled
      )
    ).toMatchObject({ key: "page:page-1:set-3" });
  });

  // The panel reads the folder's own name, so a later open is matched by its path, not the title.
  const named = { output: { ...built.output, title: "Angebote 2026" } };

  it("puts what the build found under the shown revision of the same Page", () => {
    const save = readPageSave({ args: { name: "Offers" }, result: named });
    if (save.state !== "built") {
      throw new Error("expected a revision");
    }
    const shown = pageSurface("conv-1", save, t);

    const next = ask([call("call-2", "output_available", refused)], new Set(), shown);

    expect(next).toMatchObject({ key: shown.key, fileSetId: "set-2" });
    expect(next?.buildErrors).toHaveLength(2);
  });

  it("opens nothing for a refused save of a Page that is not shown, or for another tool", () => {
    const save = readPageSave({ args: { name: "Other" }, result: built });
    if (save.state !== "built") {
      throw new Error("expected a revision");
    }

    expect(ask([call("call-1", "output_available", refused)])).toBeUndefined();
    expect(
      ask([call("call-2", "output_available", refused)], new Set(), pageSurface("conv-1", save, t))
    ).toBeUndefined();
    expect(ask([call("call-3", "output_error", undefined)])).toBeUndefined();
    expect(
      ask([{ ...call("call-4", "output_available", built), toolName: "workspace.exec" }])
    ).toBeUndefined();
  });

  it("leaves the shown revision of the same Page in place while its next save builds", () => {
    const save = readPageSave({ args: { name: "Offers" }, result: named });
    if (save.state !== "built") {
      throw new Error("expected a revision");
    }

    expect(
      ask([call("call-2", "input_available")], new Set(), pageSurface("conv-1", save, t))
    ).toBeUndefined();
    // Another Page takes the slot as soon as it starts building.
    expect(
      ask(
        [call("call-3", "input_available", undefined, "Prices")],
        new Set(),
        pageSurface("conv-1", save, t)
      )
    ).toMatchObject({ kind: "page_building", title: "Prices" });
  });

  it("puts what refused the first save onto its building Page", () => {
    const building = pageBuildingSurface("call-1", { name: "Offers" }, t);

    const errors = pageSurfaceAfterRunCalls({
      conversationId: "conv-1",
      parts: [call("call-1", "output_available", refused)],
      handled: new Set(["call-1:start"]),
      current: building,
      t
    });
    expect(errors).toMatchObject({ key: building.key, kind: "page_building" });
    expect(errors?.kind === "page_building" ? errors.buildErrors : undefined).toHaveLength(2);

    const failed = pageSurfaceAfterRunCalls({
      conversationId: "conv-1",
      parts: [call("call-1", "output_error")],
      handled: new Set(["call-1:start"]),
      current: building,
      t
    });
    expect(failed).toMatchObject({ key: building.key, failed: true });
  });

  // Check 54 of apps-and-pages: a stored conversation keeps its calls of the former name. Fails
  // without the former name among the opens: its cards and its surface were gone.
  it("reads a call of the former page.save as an open, and one that wrote the App's draft as the App", () => {
    const former = (toolCallId: string, state: string, output?: unknown) => ({
      ...call(toolCallId, state, output),
      toolName: "page.save",
      input: { name: "Offers", directory: "offers" }
    });
    const intoApp = {
      output: {
        ...built.output,
        app: { name: "offers", title: "Offers", saved: true, revision: 2 }
      }
    };

    expect(ask([former("call-1", "output_available", built)])).toMatchObject({
      kind: "page",
      key: "page:page-1:set-2",
      title: "Offers"
    });
    expect(readPageSave({ args: { name: "Offers" }, result: intoApp })).toMatchObject({
      state: "built",
      app: { title: "Offers", saved: true, revision: 2 }
    });
    // A former save that wrote the App's draft is seen as the App and opens no preview, unless
    // what it built was shown: then its revision replaces it.
    expect(ask([former("call-2", "output_available", intoApp)])).toBeUndefined();
    expect(
      pageSurfaceAfterRunCalls({
        conversationId: "conv-1",
        parts: [former("call-3", "output_available", intoApp)],
        handled: new Set(["call-3:start"]),
        current: pageBuildingSurface("call-3", { name: "Offers" }, t),
        t
      })
    ).toMatchObject({ kind: "page", key: "page:page-1:set-2" });
  });

  it("drops the findings when the next save of the Page succeeds", () => {
    const third = { output: { pageId: "page-1", number: 3, fileSetId: "set-3" } };
    const next = ask([
      call("call-1", "output_available", built),
      call("call-2", "output_available", refused),
      call("call-3", "output_available", third)
    ]);

    expect(next).toMatchObject({ key: "page:page-1:set-3" });
    expect(next?.buildErrors).toBeUndefined();
  });
});

const context: AppBridgeContext = {
  viewer: { kind: "member", id: "user-1", displayName: "Anna Beispiel" },
  workspace: null,
  locale: "de",
  theme: {
    surfaceColor: "#ffffff",
    backgroundColor: "#f6f6f4",
    textColor: "#1b1b1a",
    mutedTextColor: "#6b6b68",
    borderColor: "#e3e3df",
    accentColor: "#2f6fed",
    accentStrongColor: "#1f4fb8"
  },
  mode: "light",
  pageId: "page-1",
  fileSetNumber: 2,
  initialRoute: "/"
};

/** The windows of a shown Page: the holding document in the frame, and the Page inside it. */
function frames() {
  const posted: { message: unknown; targetOrigin: string }[] = [];
  const page = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({ message, targetOrigin });
    }
  };
  const holder = { length: 1, 0: page };
  const from = (source: unknown, data: unknown, origin = "null"): ArrivedMessage => ({
    data,
    origin,
    source
  });
  const message = (body: object) => ({ [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION, ...body });
  return { posted, page, holder, from, message };
}

describe("a message that arrives at the interface", () => {
  it("counts when it comes from the one frame inside the shown document, without an origin", () => {
    const { page, holder, from, message } = frames();

    expect(readPageMessage(from(page, message({ type: "ready" })), holder, "s-1")).toEqual(
      message({ type: "ready" })
    );
    expect(
      readPageMessage(
        from(page, message({ type: "navigate", session: "s-1", path: "/offers/3?tab=a" })),
        holder,
        "s-1"
      )
    ).toMatchObject({ type: "navigate", path: "/offers/3?tab=a" });
    expect(
      readPageMessage(
        from(page, message({ type: "resize", session: "s-1", height: 640 })),
        holder,
        "s-1"
      )
    ).toMatchObject({ type: "resize", height: 640 });
  });

  it("is dropped when it comes from any other window", () => {
    const { page, holder, from, message } = frames();
    const ready = message({ type: "ready" });

    // The holding document itself, a window that is no frame of it, and no window at all.
    expect(readPageMessage(from(holder, ready), holder, "s-1")).toBeUndefined();
    expect(readPageMessage(from({ postMessage() {} }, ready), holder, "s-1")).toBeUndefined();
    expect(readPageMessage(from(null, ready), holder, "s-1")).toBeUndefined();
    // A document with a second frame is not the holding document the instance serves.
    expect(
      readPageMessage(from(page, ready), { length: 2, 0: page, 1: {} }, "s-1")
    ).toBeUndefined();
    // No frame is mounted.
    expect(readPageMessage(from(page, ready), undefined, "s-1")).toBeUndefined();
  });

  it("is dropped when it carries an origin: a Page has none", () => {
    const { page, holder, from, message } = frames();

    expect(
      readPageMessage(
        from(page, message({ type: "ready" }), "https://chat.example.test"),
        holder,
        "s-1"
      )
    ).toBeUndefined();
  });

  it("is dropped when it is not exactly a bridge message", () => {
    const { page, holder, from, message } = frames();
    const dropped = [
      { type: "ready" },
      { ...message({ type: "ready" }), [APP_BRIDGE_MARK]: 2 },
      message({ type: "ready", extra: true }),
      message({ type: "open", url: "/settings" }),
      message({ type: "navigate", session: "s-1", path: "offers" }),
      message({ type: "navigate", session: "s-1", path: "//other.example.test/a" }),
      message({ type: "navigate", session: "s-1", path: `/${"a".repeat(2048)}` }),
      message({ type: "resize", session: "s-1", height: -1 }),
      message({ type: "resize", session: "s-1", height: Number.POSITIVE_INFINITY }),
      message({ type: "resize", session: "s-1", height: "640" }),
      "ready",
      null
    ];

    for (const data of dropped) {
      expect(
        readPageMessage(from(page, data), holder, "s-1"),
        JSON.stringify(data)
      ).toBeUndefined();
    }
  });

  it("is dropped when it names another session than this mount of the frame", () => {
    const { page, holder, from, message } = frames();

    expect(
      readPageMessage(
        from(page, message({ type: "navigate", session: "s-0", path: "/a" })),
        holder,
        "s-1"
      )
    ).toBeUndefined();
  });
});

describe("the bridge of a shown Page", () => {
  function bridge() {
    const windows = frames();
    const routes: string[] = [];
    const heights: number[] = [];
    let frame: { length: number; [index: number]: unknown } | undefined = windows.holder;
    const made = createPageBridge({
      frame: () => frame,
      session: "s-1",
      context: () => context,
      onNavigate: (path) => routes.push(path),
      onResize: (height) => heights.push(height)
    });
    return {
      ...windows,
      made,
      routes,
      heights,
      setFrame(next: typeof frame) {
        frame = next;
      }
    };
  }

  it("answers the greeting with the context and the session, to the Page alone", () => {
    const { made, posted, page, from, message } = bridge();

    made.receive(from(page, message({ type: "ready" })));

    expect(posted).toEqual([{ message: contextMessage("s-1", context), targetOrigin: "*" }]);
    expect(appBridgeHostMessageSchema.safeParse(posted[0]?.message).success).toBe(true);
  });

  it("answers nothing to a window that is not the Page", () => {
    const { made, posted, holder, from, message } = bridge();

    made.receive(from(holder, message({ type: "ready" })));
    made.receive(from({ postMessage() {} }, message({ type: "ready" })));

    expect(posted).toEqual([]);
  });

  it("hands on the route and the height a Page reports, and nothing it may not send", () => {
    const { made, routes, heights, page, from, message } = bridge();

    made.receive(from(page, message({ type: "navigate", session: "s-1", path: "/offers" })));
    made.receive(from(page, message({ type: "resize", session: "s-1", height: 900 })));
    made.receive(from(page, message({ type: "navigate", session: "other", path: "/x" })));
    made.receive(from(page, message({ type: "navigate", session: "s-1", path: "https://x.test" })));

    expect(routes).toEqual(["/offers"]);
    expect(heights).toEqual([900]);
  });

  it("tells the look to the Page that greeted, and to none after the frame changed", () => {
    const { made, posted, page, from, message, setFrame } = bridge();
    const look = { theme: context.theme, mode: "dark" as const };

    made.sendLook(look);
    expect(posted).toEqual([]);

    made.receive(from(page, message({ type: "ready" })));
    made.sendLook(look);
    expect(posted.at(-1)).toEqual({ message: themeMessage(look), targetOrigin: "*" });

    setFrame({ length: 1, 0: { postMessage() {} } });
    made.sendLook(look);
    setFrame(undefined);
    made.sendLook(look);
    expect(posted).toHaveLength(2);
  });
});

describe("the frame of a Page", () => {
  it("allows scripts, form events and downloads without an origin, sends no referrer and loads the address it was given", () => {
    const markup = render(
      createElement(PreviewPane, {
        source: { kind: "bundle", url: "https://api.example.test/app-content/set-2/token/" },
        state: "ready",
        title: "Preview of Offers"
      })
    );

    expect(markup).toMatch(/^<iframe /u);
    expect(markup).toContain('sandbox="allow-scripts allow-forms allow-downloads"');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain('src="https://api.example.test/app-content/set-2/token/"');
    expect(markup).toContain('title="Preview of Offers"');
    expect(markup).not.toMatch(/allow-same-origin|allow-popups|allow-top-navigation/u);
    expect(markup).not.toMatch(/\ballow="/u);
  });

  it("is addressed on the API's origin, wherever the interface is served from", () => {
    const page = "https://chat.example.test/c/conv-1";

    expect(pageFrameAddress("/app-content/set-2/token/", "https://api.example.test", page)).toBe(
      "https://api.example.test/app-content/set-2/token/"
    );
    expect(pageFrameAddress("/app-content/set-2/token/", "/", page)).toBe(
      "https://chat.example.test/app-content/set-2/token/"
    );
  });

  it("shows a sentence in the frame's place in every other state, and no frame", () => {
    const pane = (state: "starting" | "stopped" | "failed", message: string) =>
      render(
        createElement(PreviewPane, {
          source: undefined,
          state,
          message,
          title: "Preview of Offers",
          action: createElement("span", null, "again")
        })
      );

    const starting = pane("starting", t("pages.loading"));
    expect(starting).toContain('role="status"');
    expect(starting).toContain("The preview is loading");
    // Nothing to try again while it is on its way.
    expect(starting).not.toContain("again");
    expect(pane("stopped", t("pages.gone"))).toContain(
      "This preview is no longer available to you."
    );
    expect(pane("failed", t("pages.loadFailed"))).toContain("again");
    for (const state of ["starting", "stopped", "failed"] as const) {
      expect(pane(state, "x")).not.toContain("<iframe");
    }
    // A ready state without an address shows no frame either.
    expect(
      render(createElement(PreviewPane, { source: undefined, state: "ready", title: "x" }))
    ).not.toContain("<iframe");
  });
});

describe("the content of a Page surface", () => {
  const errors = [
    { file: "src/routes/index.tsx", line: 12, message: "Expected '}'" },
    { file: "app.yaml", message: "The kit version is not released." }
  ];
  const view = (
    input: { view: "preview" | "files"; buildErrors?: typeof errors; revision?: number },
    locale?: "de"
  ) =>
    render(
      createElement(PageSurfaceView, {
        ...input,
        preview: createElement("p", null, "the preview"),
        files: createElement("p", null, "the files")
      }),
      locale
    );

  it("shows the build errors as one folded line under the preview", () => {
    const markup = view({ view: "preview", buildErrors: errors });

    expect(markup.indexOf("the preview")).toBeLessThan(markup.indexOf("2 build errors"));
    expect(markup).toMatch(
      /data-state="closed"[^>]*data-testid="page-build-errors"|data-testid="page-build-errors"[^>]*data-state="closed"/u
    );
    expect(view({ view: "preview", buildErrors: errors }, "de")).toContain("2 Build-Fehler");
    expect(view({ view: "preview", buildErrors: errors.slice(0, 1) })).toContain("1 build error");
  });

  it("says under the count that the preview still shows what it showed and what to do", () => {
    const shown = (count: number, locale?: "de") =>
      render(
        createElement(PageBuildErrors, { errors: errors.slice(0, count), previewShown: true }),
        locale
      );

    // Outside the folded findings: the sentence is in the document while they are not.
    expect(shown(2)).toContain(
      "The preview still shows the last version. Ask the agent to fix the errors."
    );
    expect(shown(2)).not.toContain("Expected");
    expect(shown(1)).toContain("Ask the agent to fix the error.");
    expect(shown(1, "de")).toContain(
      "Die Vorschau zeigt weiter den letzten Stand. Bitte den Agenten, den Fehler zu beheben."
    );
    expect(shown(2, "de")).toContain("Bitte den Agenten, die Fehler zu beheben.");
    expect(view({ view: "preview", buildErrors: errors, revision: 3 }, "de")).toContain(
      "Die Vorschau zeigt weiter den letzten Stand."
    );
    expect(shown(2)).not.toMatch(/>[^<]*revision/iu);
    // Before the instance said which revision the frame holds, the line says nothing of it.
    expect(view({ view: "preview", buildErrors: errors })).not.toContain("still shows");
  });

  it("shows no line without a finding", () => {
    expect(view({ view: "preview" })).not.toContain("page-build-errors");
    expect(view({ view: "preview", buildErrors: [] })).not.toContain("page-build-errors");
  });

  it("keeps the preview mounted under the files, so the Page keeps its state", () => {
    const markup = view({ view: "files", buildErrors: errors });

    expect(markup).toContain("the files");
    expect(markup).toMatch(/<div class="[^"]*" hidden="">(?:<p>)?the preview/u);
    expect(markup).not.toContain("page-build-errors");
    expect(view({ view: "preview" })).not.toContain("the files");
  });

  it("names each finding by file and line with the build's message", () => {
    const markup = render(createElement("div", null, createElement(PageBuildErrors, { errors })));

    expect(markup).toContain("2 build errors");
    // Folded, the findings are not in the document; the trigger says they can be unfolded.
    expect(markup).toContain('aria-expanded="false"');
  });
});

describe("the files of a revision", () => {
  const files = [
    { path: "app.yaml", sha256: "a1" },
    { path: "src/routes/__root.tsx", sha256: "b1" },
    { path: "src/routes/index.tsx", sha256: "c2" },
    { path: "src/routes/table.tsx", sha256: "d1" }
  ];
  const before = [
    { path: "app.yaml", sha256: "a1" },
    { path: "src/routes/__root.tsx", sha256: "b1" },
    { path: "src/routes/index.tsx", sha256: "c1" }
  ];

  it("counts a file as changed when the revision before held it differently or not at all", () => {
    expect([...changedSourcePaths(files, before)]).toEqual([
      "src/routes/index.tsx",
      "src/routes/table.tsx"
    ]);
    // The first revision brought every file; none of them is a change.
    expect(changedSourcePaths(files, undefined).size).toBe(0);
  });

  it("opens the first changed file, the manifest only when nothing else changed", () => {
    expect(defaultOpenPath(files, changedSourcePaths(files, before))).toBe("src/routes/index.tsx");
    expect(defaultOpenPath(files, new Set(["app.yaml", "src/routes/table.tsx"]))).toBe(
      "src/routes/table.tsx"
    );
    expect(defaultOpenPath(files, new Set(["app.yaml"]))).toBe("app.yaml");
  });

  it("opens where the Page starts when the revision changed nothing", () => {
    expect(defaultOpenPath(files, new Set())).toBe("src/routes/index.tsx");
    expect(
      defaultOpenPath(
        [
          { path: "index.html", sha256: "x" },
          { path: "app.yaml", sha256: "y" }
        ],
        new Set()
      )
    ).toBe("index.html");
    expect(defaultOpenPath([{ path: "notes.md", sha256: "x" }], new Set())).toBe("notes.md");
    expect(defaultOpenPath([], new Set())).toBeUndefined();
  });

  const filesView = (overrides: Partial<Parameters<typeof PageFilesView>[0]> = {}) =>
    render(
      createElement(PageFilesView, {
        files,
        changed: changedSourcePaths(files, before),
        open: "src/routes/index.tsx",
        content: { status: "ready", text: "export const Route = 1;\n" },
        listShown: false,
        onOpen: () => undefined,
        onShowList: () => undefined,
        ...overrides
      })
    );

  it("lists every file, marks the changed ones and the open one, and shows the open file read-only", () => {
    const markup = filesView();

    for (const file of files) {
      expect(markup).toContain(`>${file.path}</span>`);
    }
    expect(markup.match(/>Changed</gu)).toHaveLength(2);
    expect(markup).toContain('aria-label="Source files"');
    expect(markup).toMatch(/role="region" aria-label="src\/routes\/index\.tsx"/u);
    expect(markup).toContain("export const Route = 1;");
    // The header above the text holds a switch and a copy button; the text itself takes no
    // input.
    const text = /<div role="region"[\s\S]*?<\/pre><\/div>/u.exec(markup)?.[0] ?? "";
    expect(text).toContain("export const Route = 1;");
    expect(text).not.toMatch(/<(?:textarea|input|button)\b|contenteditable/u);
    expect(markup).not.toMatch(/<textarea\b|contenteditable/u);
  });

  it("says so when the files are loading, failed, absent or not text", () => {
    expect(filesView({ files: "loading" })).not.toContain("Source files");
    expect(filesView({ files: "failed" })).toContain("The files could not be loaded.");
    expect(filesView({ files: [], open: undefined })).toContain(
      "This preview has no source files."
    );
    expect(filesView({ content: { status: "not-text" } })).toContain(
      "This file is not text and cannot be shown."
    );
    expect(filesView({ content: { status: "failed" } })).toContain(
      "The files could not be loaded."
    );
  });
});

describe("the card of an open", () => {
  const card = (
    save: PageSave,
    props: { shown?: boolean; onOpen?: () => void } = {},
    locale?: "de"
  ) =>
    render(
      createElement(PageSaveCardView, { save, shown: props.shown ?? false, onOpen: props.onOpen }),
      locale
    );
  const revision: PageSave = {
    state: "built",
    name: "Offers",
    pageId: "page-1",
    fileSetId: "set-2",
    number: 2
  };

  it("names the Page, no revision number, and opens it, unless it is the one shown", () => {
    const open = card(revision, { onOpen: () => undefined });

    expect(open).toContain(">Offers</p>");
    expect(open).not.toMatch(/>[^<]*revision/iu);
    expect(open).toMatch(/<button[^>]*>Open<\/button>/u);
    const shown = card(revision, { shown: true, onOpen: () => undefined });
    expect(shown).toContain("Shown");
    expect(shown).not.toContain("<button");
    expect(card(revision, { onOpen: () => undefined }, "de")).toMatch(/>Öffnen<\/button>/u);
    // Where there is no slot to open it in, the card names the Page and offers nothing.
    expect(card(revision)).not.toContain("<button");
  });

  it("says that the Page is being built while the call runs", () => {
    const markup = card({ state: "building", name: "Offers" });

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Building the preview");
    expect(card({ state: "building", name: "Offers" }, {}, "de")).toContain(
      "Die Vorschau wird gebaut"
    );
  });

  it("says that the build refused the save and how many findings it has", () => {
    const markup = card({
      state: "errors",
      name: "Offers",
      errors: [{ file: "src/routes/index.tsx", line: 12, message: "Expected '}'" }]
    });

    expect(markup).toContain("The preview could not be built");
    expect(markup).toContain("1 build error");
    expect(markup).not.toMatch(/>Open</u);
    // No revision was built by this open, so the card says that and what to do.
    expect(markup).toContain("Nothing new is shown. Ask the agent to fix the error.");
    expect(
      card({ state: "errors", name: "Offers", errors: refused.output.errors }, {}, "de")
    ).toContain("Es wird nichts Neues gezeigt. Bitte den Agenten, die Fehler zu beheben.");
  });

  it("says that the open failed, and names an open without a name as the preview", () => {
    const markup = card({ state: "failed", name: undefined });

    expect(markup).toContain("The preview could not be opened");
    expect(markup).toContain(">Preview</p>");
  });
});
