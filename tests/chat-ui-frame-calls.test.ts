import {
  APP_BRIDGE_CONNECTION_CALL_REMOVED,
  APP_BRIDGE_MARK,
  APP_BRIDGE_VERSION,
  type AppBridgeContext
} from "@work-shape/catalyst-api-contract";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import {
  callResultMessage,
  contextMessage,
  createFrameCalls,
  createPageBridge,
  frameCallFailure,
  workflowRunResultMessage,
  frameSessionProof,
  FrameTestRunView,
  frameTestRunTitle,
  useFrameCallTexts,
  type ArrivedMessage,
  type FrameCallAnswer,
  type FrameCalls,
  type FrameTestRun,
  type FrameWorkflowRunAnswer
} from "@work-shape/catalyst-chat-ui/pages";

const NOT_ASKED = { code: "failed", message: "not asked" };

// The calls a Page asks the interface to make: what the bridge does with a call message, and
// how the interface names the frame to the instance.
// Every test here fails without the change: the bridge read no call of a Page, and the
// interface had no way to make one.

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

describe("a call a Page asks the interface to make", () => {
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  function bridge(
    calls: FrameCalls | undefined,
    onCallWaits?: (runId: string) => void,
    onTestRun?: (run: FrameTestRun) => void
  ) {
    const windows = frames();
    let frame: { length: number; [index: number]: unknown } | undefined = windows.holder;
    const made = createPageBridge({
      frame: () => frame,
      session: "s-1",
      context: () => context,
      onNavigate: () => undefined,
      onResize: () => undefined,
      calls: () => calls,
      ...(onCallWaits ? { onCallWaits } : {}),
      ...(onTestRun ? { onTestRun } : {})
    });
    return {
      ...windows,
      made,
      setFrame(next: typeof frame) {
        frame = next;
      }
    };
  }

  it("serializes personal writes, rejects foreign frames and answers a failed write without server text", async () => {
    const mutations: unknown[] = [];
    const { made, posted, page, from, message } = bridge({
      can: () => Promise.resolve(undefined),
      run: () => Promise.reject(new Error("not asked")),
      workflowRun: () => Promise.reject(new Error("not asked")),
      writeStorage: async (mutation) => {
        mutations.push(mutation);
        if (mutations.length === 1) throw new Error("private provider text");
      }
    });
    const first = {
      type: "storage_write",
      session: "s-1",
      requestId: "r-1",
      mutation: { type: "set", key: "note", value: "first" }
    };
    made.receive(from({}, message(first)));
    made.receive(from(page, message({ ...first, session: "another-session" })));
    expect(mutations).toEqual([]);
    made.receive(from(page, message(first)));
    made.receive(
      from(page, message({ ...first, requestId: "r-2", mutation: { type: "remove", key: "note" } }))
    );
    await settled();
    expect(mutations).toEqual([first.mutation, { type: "remove", key: "note" }]);
    expect(posted.map((item) => item.message)).toEqual([
      message({ type: "storage_result", session: "s-1", requestId: "r-1", ok: false }),
      message({ type: "storage_result", session: "s-1", requestId: "r-2", ok: true })
    ]);
  });

  it("is made once, and its answer goes to the Page under the id the Page gave it", async () => {
    const ran: unknown[] = [];
    const { made, posted, page, from, message } = bridge({
      writeStorage: () => Promise.resolve(),
      can: () => Promise.resolve({ load: "allow", save: "deny" }),
      run: (call) => {
        ran.push(call);
        return Promise.resolve({ ok: true, result: { runId: "run-1", status: "done", result: 7 } });
      },
      workflowRun: () => Promise.reject(new Error("not asked"))
    });

    made.receive(from(page, message({ type: "ready" })));
    await settled();
    // The context names what the viewer may do with each action.
    expect(posted).toEqual([
      {
        message: contextMessage("s-1", { ...context, can: { load: "allow", save: "deny" } }),
        targetOrigin: "*"
      }
    ]);

    const call = { type: "action", session: "s-1", requestId: "r-1", name: "load", input: {} };
    made.receive(from(page, message(call)));
    // A call that names another session, or comes from another window, is not made.
    made.receive(from(page, message({ ...call, session: "other" })));
    made.receive(from({ postMessage() {} }, message(call)));
    await settled();

    expect(ran).toEqual([{ [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION, ...call }]);
    expect(posted.at(-1)).toEqual({
      message: callResultMessage("s-1", "r-1", {
        ok: true,
        result: { runId: "run-1", status: "done", result: 7 }
      }),
      targetOrigin: "*"
    });
    expect(posted).toHaveLength(2);
  });

  it("is answered to nobody when the frame shows another document by then", async () => {
    const { made, posted, page, from, message, setFrame } = bridge({
      writeStorage: () => Promise.resolve(),
      can: () => Promise.resolve(undefined),
      run: () => Promise.resolve({ ok: false, error: { code: "failed", message: "No" } }),
      workflowRun: () => Promise.reject(new Error("not asked"))
    });

    made.receive(
      from(
        page,
        message({ type: "action", session: "s-1", requestId: "r-1", name: "load", input: {} })
      )
    );
    setFrame({ length: 1, 0: { postMessage() {} } });
    await settled();

    expect(posted).toEqual([]);
  });

  // DAILY-WINS 9: a call held for an approval is said by the host over the frame, so the
  // bridge tells it which run waits, for that answer alone and only to a frame still shown.
  it("tells the host which run waits when a call is held for an approval", async () => {
    const answers: FrameCallAnswer[] = [
      { ok: true, result: { runId: "run-held", status: "pending_approval" } },
      { ok: true, result: { runId: "run-done", status: "done", result: 1 } },
      { ok: true, result: { status: "dry_run", message: "Would send", result: {} } },
      { ok: false, error: { code: "forbidden", message: "No" } }
    ];
    const waits: string[] = [];
    const { made, page, from, message, setFrame } = bridge(
      {
        writeStorage: () => Promise.resolve(),
        can: () => Promise.resolve(undefined),
        run: () => Promise.resolve(answers.shift() ?? { ok: false, error: NOT_ASKED }),
        workflowRun: () => Promise.reject(new Error("not asked"))
      },
      (runId) => waits.push(runId)
    );
    const call = (requestId: string) =>
      from(page, message({ type: "action", session: "s-1", requestId, name: "send", input: {} }));

    for (const requestId of ["r-1", "r-2", "r-3", "r-4"]) {
      made.receive(call(requestId));
      await settled();
    }
    expect(waits).toEqual(["run-held"]);

    // A frame that shows another document by the answer has nobody waiting on it.
    answers.push({ ok: true, result: { runId: "run-late", status: "pending_approval" } });
    made.receive(call("r-5"));
    setFrame({ length: 1, 0: { postMessage() {} } });
    await settled();
    expect(waits).toEqual(["run-held"]);
  });

  // Fails before DP-1: a test run the draft started looked like a live one in the frame.
  it("tells the host of a test run a call of the draft started, and of each read of it", async () => {
    const test = {
      id: "wfr-7",
      workflow: "notify-clients",
      status: "running" as const,
      mode: "test" as const,
      workflowRevision: { kind: "draft" as const, number: 7 }
    };
    const reads: FrameWorkflowRunAnswer[] = [
      { ok: true, run: test },
      { ok: true, run: { ...test, status: "done", simulatedSteps: ["send"] } },
      { ok: true, run: { id: "wfr-8", workflow: "notify-clients", status: "done" } }
    ];
    const answers: FrameCallAnswer[] = [
      {
        ok: true,
        result: { runId: "op-1", status: "done", result: { id: "wfr-7", mode: "test" } }
      },
      { ok: true, result: { runId: "op-2", status: "done", result: { id: "wfr-8", mode: "live" } } }
    ];
    const shown: FrameTestRun[] = [];
    const { made, page, from, message } = bridge(
      {
        writeStorage: () => Promise.resolve(),
        can: () => Promise.resolve(undefined),
        run: () => Promise.resolve(answers.shift() ?? { ok: false, error: NOT_ASKED }),
        workflowRun: () => Promise.resolve(reads.shift() ?? { ok: false, error: NOT_ASKED })
      },
      undefined,
      (run) => shown.push(run)
    );
    const call = (requestId: string) =>
      from(page, message({ type: "action", session: "s-1", requestId, name: "notify", input: {} }));
    const read = (requestId: string, runId: string) =>
      from(page, message({ type: "workflow_run", session: "s-1", requestId, runId }));

    // The call's answer names a test run: the host reads it once for which revision ran.
    made.receive(call("r-1"));
    await settled();
    await settled();
    expect(shown).toEqual([test]);
    // The Page's own reads tell the rest, such as the steps that were simulated.
    made.receive(read("r-2", "wfr-7"));
    await settled();
    expect(shown.at(-1)).toMatchObject({ status: "done", simulatedSteps: ["send"] });
    // A live run is no test run, and a read of one tells the host nothing.
    made.receive(call("r-3"));
    await settled();
    made.receive(read("r-4", "wfr-8"));
    await settled();
    expect(shown).toHaveLength(2);
  });

  // Fails before DP-1: the frame said nothing of a test run, so its result read as real.
  it("marks a test run over the frame with the revision that ran and the steps simulated", () => {
    const route = {
      kind: "workflow-run" as const,
      collaborationWorkspaceId: "cw_1",
      workflow: "notify-clients",
      run: "wfr-7"
    };
    const strip = (run: Parameters<typeof FrameTestRunView>[0]["run"], locale: "en" | "de") =>
      renderToStaticMarkup(
        createElement(TranslationProvider, {
          locale,
          children: createElement(FrameTestRunView, {
            run,
            route,
            onOpen: () => undefined,
            onClose: () => undefined
          })
        })
      );
    const draft = strip(
      { id: "wfr-7", workflowRevision: { kind: "draft", number: 7 }, simulatedSteps: ["a", "b"] },
      "de"
    );
    expect(draft).toContain("Testlauf des Entwurfs · Workflow-Entwurf");
    // The frame names no revision number, as nothing of an App's preview does (OPEN-1f).
    expect(draft).not.toContain("r7");
    expect(draft).toContain("2 Schritte simuliert");
    expect(draft).toContain("Lauf ansehen");
    expect(draft).toContain('href="/w/cw_1/workflows/notify-clients/runs/wfr-7"');
    const published = strip(
      { id: "wfr-7", workflowRevision: { kind: "published", number: 5 }, simulatedSteps: [] },
      "en"
    );
    expect(published).toContain("Test run · published Workflow");
    expect(published).not.toContain("simulated");
    expect(published).toContain("View run");
    expect(frameTestRunTitle({})).toBe("pages.testRunDraft");
  });

  // Fails before the removal: the bridge made the call of a Connection operation the Page named.
  it("refuses the retired free call of a Connection at once, names the named action as the fix, and calls nothing", async () => {
    const ran: unknown[] = [];
    const { made, posted, page, from, message } = bridge({
      writeStorage: () => Promise.resolve(),
      can: () => Promise.resolve(undefined),
      run: (call) => {
        ran.push(call);
        return Promise.resolve({ ok: true, result: { runId: "run-1", status: "done" } });
      },
      workflowRun: () => Promise.reject(new Error("not asked"))
    });

    // What `connections.call` of kits 1.0.0 to 1.3.0 still sends.
    made.receive(
      from(
        page,
        message({
          type: "connection_call",
          session: "s-1",
          requestId: "r-1",
          connection: "crm",
          operation: "list",
          input: {}
        })
      )
    );
    await settled();

    expect(ran).toEqual([]);
    expect(posted).toEqual([
      {
        message: callResultMessage("s-1", "r-1", {
          ok: false,
          error: { ...APP_BRIDGE_CONNECTION_CALL_REMOVED }
        }),
        targetOrigin: "*"
      }
    ]);
    expect(APP_BRIDGE_CONNECTION_CALL_REMOVED).toMatchObject({
      code: "connection_call_removed",
      retryable: false,
      message: expect.stringContaining("named action")
    });
    expect(APP_BRIDGE_CONNECTION_CALL_REMOVED.message).toContain("actions/<name>.action.yaml");
  });

  // Fails without APP-6a: the bridge took no read of a Workflow Run, so a Page that started one
  // could not follow it.
  it("reads a Workflow Run for the Page and answers it under the id the Page gave the read", async () => {
    const read: string[] = [];
    const run = { id: "wfr-1", workflow: "visit-log-entries", status: "done" as const, output: 1 };
    const { made, posted, page, from, message } = bridge({
      writeStorage: () => Promise.resolve(),
      can: () => Promise.resolve(undefined),
      run: () => Promise.reject(new Error("not asked")),
      workflowRun: (runId) => {
        read.push(runId);
        return Promise.resolve({ ok: true, run });
      }
    });

    made.receive(
      from(
        page,
        message({ type: "workflow_run", session: "s-1", requestId: "r-2", runId: "wfr-1" })
      )
    );
    // A read that carries more than the run's id is no message of the bridge.
    made.receive(
      from(
        page,
        message({ type: "workflow_run", session: "s-1", requestId: "r-3", runId: "wfr-1", x: 1 })
      )
    );
    await settled();

    expect(read).toEqual(["wfr-1"]);
    expect(posted).toEqual([
      { message: workflowRunResultMessage("s-1", "r-2", { ok: true, run }), targetOrigin: "*" }
    ]);
  });

  it("is refused where the frame has no way to the instance, and the context names no action", async () => {
    const { made, posted, page, from, message } = bridge(undefined);

    made.receive(from(page, message({ type: "ready" })));
    made.receive(
      from(
        page,
        message({ type: "action", session: "s-1", requestId: "r-1", name: "load", input: {} })
      )
    );
    await settled();

    expect(posted).toEqual([
      { message: contextMessage("s-1", context), targetOrigin: "*" },
      {
        message: callResultMessage("s-1", "r-1", {
          ok: false,
          error: { code: "not_available", message: "This frame cannot make calls." }
        }),
        targetOrigin: "*"
      }
    ]);
  });
});

describe("the calls of a frame", () => {
  const address = {
    url: "https://api.example.test/app-content/session-1/set-2/token-3/",
    fileSetId: "set-2",
    pageSessionId: "session-1"
  };
  const refusal = (status: number, code: string, message: string, details?: object) =>
    new ApiError(status, message, { error: { code, message, ...(details ? { details } : {}) } });

  it("are named to the instance by what the frame's address holds, and by nothing else", () => {
    expect(frameSessionProof(address)).toEqual({
      pageSessionId: "session-1",
      fileSetId: "set-2",
      token: "token-3"
    });
    expect(frameSessionProof({ ...address, url: `${address.url}index.html?x=1#top` })).toEqual(
      expect.objectContaining({ token: "token-3" })
    );
    expect(
      frameSessionProof({ ...address, url: "https://api.example.test/other/" })
    ).toBeUndefined();
    expect(
      frameSessionProof({ ...address, url: "https://api.example.test/app-content/set-2" })
    ).toBeUndefined();
  });

  it("carry the proof and the frame's key, and no key the frame did not give", async () => {
    const sent: unknown[] = [];
    const answer = { runId: "run-1", status: "done" as const, result: { rows: [] } };
    const record = (operation: string) => (request: unknown) => {
      sent.push({ operation, request });
      return Promise.resolve(answer);
    };
    const run = { id: "wfr-1", workflow: "visit-log-entries", status: "running" as const };
    const calls = createFrameCalls(
      {
        apps: {
          sessions: {
            write_storage: () =>
              Promise.resolve({
                status: "done" as const,
                output: { saved: true as const },
                operationRunId: "storage-1",
                replayed: false
              }),
            context: () => Promise.resolve({ can: { load: "allow" as const } }),
            call_action: record("call_action"),
            get_workflow_run: (request: unknown) => {
              sent.push({ operation: "get_workflow_run", request });
              return Promise.resolve(run);
            }
          }
        }
      },
      address
    );
    if (!calls) throw new Error("The address names a frame");

    expect(await calls.can()).toEqual({ load: "allow" });
    expect(
      await calls.run({
        type: "action",
        name: "save",
        input: { note: "x" },
        idempotencyKey: "key-1"
      })
    ).toEqual({ ok: true, result: answer });
    expect(await calls.workflowRun("wfr-1")).toEqual({ ok: true, run });

    const proof = { fileSetId: "set-2", token: "token-3" };
    expect(sent).toEqual([
      {
        operation: "call_action",
        request: {
          params: { pageSessionId: "session-1", name: "save" },
          body: { ...proof, input: { note: "x" } },
          idempotencyKey: "key-1"
        }
      },
      {
        operation: "get_workflow_run",
        request: { params: { pageSessionId: "session-1", runId: "wfr-1" }, body: proof }
      }
    ]);
  });

  it("tell a Page a fixed word for what refused it, the right where one is missing, and that trying again will not help", () => {
    expect(
      frameCallFailure(
        refusal(403, "FORBIDDEN", "Not allowed", { action: "connection.use", reason: "no_grant" })
      )
    ).toEqual({
      code: "forbidden",
      message: "Not allowed",
      right: "connection.use",
      retryable: false
    });
    expect(
      frameCallFailure(
        refusal(409, "CONFLICT", "A draft changes nothing", { reason: "draft_safe_mode" })
      )
    ).toEqual({
      code: "draft_safe_mode",
      message: "A draft changes nothing",
      retryable: false
    });
    expect(
      frameCallFailure(refusal(404, "NOT_FOUND", "No such action", { reason: "action_unknown" }))
    ).toEqual({ code: "action_unknown", message: "No such action", retryable: false });
    // Fails without the change: a Page that reads a Data Store was offered to try again.
    expect(
      frameCallFailure(
        refusal(409, "CONFLICT", "Save it as an App", { reason: "data_store_needs_app" })
      )
    ).toEqual({ code: "data_store_needs_app", message: "Save it as an App", retryable: false });
    // A limit passes, so the Page may offer to try again.
    expect(frameCallFailure(refusal(429, "RATE_LIMITED", "Too many calls"))).toEqual({
      code: "rate_limited",
      message: "Too many calls"
    });
  });

  // Fails without PREVIEW-1: nothing outside the frame heard that a preview is no App, so the
  // person saw only what the agent's code made of the refusal.
  it("tell the surface when a call was refused because the preview is no App, and only then", async () => {
    const refusals = [
      refusal(409, "CONFLICT", "Save it as an App", { reason: "data_store_needs_app" }),
      refusal(409, "CONFLICT", "A draft changes nothing", { reason: "draft_safe_mode" })
    ];
    let heard = 0;
    const calls = createFrameCalls(
      {
        apps: {
          sessions: {
            write_storage: () => Promise.reject(new Error("not asked")),
            context: () => Promise.resolve({ can: {} }),
            call_action: () => Promise.reject(refusals.shift()),
            get_workflow_run: () => Promise.reject(new Error("not asked"))
          }
        }
      },
      address,
      undefined,
      { onPreviewIsNoApp: () => (heard += 1) }
    );
    if (!calls) throw new Error("The address names a frame");

    const first = await calls.run({ type: "action", name: "load", input: {} });
    expect(first).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "data_store_needs_app" })
    });
    expect(heard).toBe(1);
    await calls.run({ type: "action", name: "save", input: {} });
    expect(heard).toBe(1);
  });

  // Fails without the fix round: the run of a refused or failed call was dropped, so
  // `AppCallError.runId` named nothing, and each App worded a missing right itself.
  it("keep the run of a refusal and word a missing right on a Connection in the person's language", () => {
    const texts = {
      connectionUseDenied: (label: string | undefined, frame: "page" | "app") =>
        `sentence for ${label ?? `no label in the ${frame}`}`
    };
    const denied = (details: Record<string, unknown>) =>
      frameCallFailure(
        refusal(403, "FORBIDDEN", "Missing the right", {
          action: "connection.use",
          reason: "no_grant",
          operationRunId: "oprun_1",
          ...details
        }),
        texts
      );

    expect(denied({ connectionUseDenied: true, connectionLabel: "Warehouse" })).toEqual({
      code: "forbidden",
      message: "sentence for Warehouse",
      right: "connection.use",
      retryable: false,
      runId: "oprun_1"
    });
    // A viewer who may not read the Connection is told no label.
    // It names what the person looks at, and never calls a Page an app.
    expect(denied({ connectionUseDenied: true, frame: "app" }).message).toBe(
      "sentence for no label in the app"
    );
    expect(denied({ connectionUseDenied: true, frame: "page" }).message).toBe(
      "sentence for no label in the page"
    );
    // Another missing right keeps the sentence of the instance.
    expect(denied({ action: "app.use" }).message).toBe("Missing the right");
    expect(
      frameCallFailure(
        refusal(502, "CONNECTION_FAILED", "The system answered an error", {
          reason: "upstream_error",
          operationRunId: "oprun_2"
        })
      )
    ).toEqual({
      code: "upstream_error",
      message: "The system answered an error",
      runId: "oprun_2"
    });
  });

  it("word a missing right on a Connection with whom to ask, never a page the person cannot open", () => {
    const API = "https://chat.example.com";
    const sentence = (instanceAdminName: string | undefined, locale: "en" | "de" = "en") => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(["me", API], { instanceAdminName });
      function Probe() {
        return useFrameCallTexts().connectionUseDenied("Warehouse", "app");
      }
      return renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            WorkspaceApiClientProvider,
            { apiBaseUrl: API, children: null },
            createElement(TranslationProvider, { locale, children: createElement(Probe) })
          )
        )
      );
    };
    expect(sentence("Mara")).toBe(
      "You may not use the connection Warehouse, so this cannot load. Trying again will not help. Ask an instance admin, for example Mara."
    );
    expect(sentence(undefined)).toContain("Ask an instance admin.");
    expect(sentence("Mara", "de")).toContain("zum Beispiel Mara.");
    for (const text of [sentence("Mara"), sentence("Mara", "de")]) {
      expect(text).not.toMatch(/Settings|Einstellungen/u);
    }
  });

  it("tell a Page nothing of what is no answer of the instance", () => {
    // What is no answer of the instance tells the Page nothing about the interface.
    expect(frameCallFailure(new TypeError("fetch failed: secret-host"))).toEqual({
      code: "failed",
      message: "The call could not be made."
    });
  });
});
