import {
  APP_BRIDGE_MARK,
  APP_BRIDGE_VERSION,
  type AppBridgeContext
} from "@vivd-catalyst/api-contract";
import { describe, expect, it } from "vitest";
import { ApiError } from "@vivd-catalyst/api-client";
import {
  callResultMessage,
  contextMessage,
  createFrameCalls,
  createPageBridge,
  frameCallFailure,
  workflowRunResultMessage,
  frameSessionProof,
  type ArrivedMessage,
  type FrameCalls
} from "@vivd-catalyst/chat-ui/pages";

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

  function bridge(calls: FrameCalls | undefined) {
    const windows = frames();
    let frame: { length: number; [index: number]: unknown } | undefined = windows.holder;
    const made = createPageBridge({
      frame: () => frame,
      session: "s-1",
      context: () => context,
      onNavigate: () => undefined,
      onResize: () => undefined,
      calls: () => calls
    });
    return {
      ...windows,
      made,
      setFrame(next: typeof frame) {
        frame = next;
      }
    };
  }

  it("is made once, and its answer goes to the Page under the id the Page gave it", async () => {
    const ran: unknown[] = [];
    const { made, posted, page, from, message } = bridge({
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
      can: () => Promise.resolve(undefined),
      run: () => Promise.resolve({ ok: false, error: { code: "failed", message: "No" } }),
      workflowRun: () => Promise.reject(new Error("not asked"))
    });

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
    setFrame({ length: 1, 0: { postMessage() {} } });
    await settled();

    expect(posted).toEqual([]);
  });

  // Fails without APP-6a: the bridge took no read of a Workflow Run, so a Page that started one
  // could not follow it.
  it("reads a Workflow Run for the Page and answers it under the id the Page gave the read", async () => {
    const read: string[] = [];
    const run = { id: "wfr-1", workflow: "visit-log-entries", status: "done" as const, output: 1 };
    const { made, posted, page, from, message } = bridge({
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
            context: () => Promise.resolve({ can: { load: "allow" as const } }),
            call_action: record("call_action"),
            call_connection: record("call_connection"),
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
    await calls.run({
      type: "connection_call",
      connection: "crm",
      operation: "list",
      input: { limit: 5 }
    });
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
        operation: "call_connection",
        request: {
          params: { pageSessionId: "session-1", connection: "crm", operation: "list" },
          body: { ...proof, input: { limit: 5 } }
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
      frameCallFailure(
        refusal(403, "FORBIDDEN", "Not listed", { reason: "connection_not_declared" })
      )
    ).toEqual({ code: "connection_not_declared", message: "Not listed", retryable: false });
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

  it("tell a Page nothing of what is no answer of the instance", () => {
    // What is no answer of the instance tells the Page nothing about the interface.
    expect(frameCallFailure(new TypeError("fetch failed: secret-host"))).toEqual({
      code: "failed",
      message: "The call could not be made."
    });
  });
});
