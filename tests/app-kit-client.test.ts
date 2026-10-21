import {
  APP_BRIDGE_MARK,
  APP_BRIDGE_VERSION,
  appBridgeHostMessageSchema,
  appBridgePageMessageSchema,
  type AppBridgeContext
} from "@work-shape/catalyst-api-contract";
import { loadAppKitFiles } from "@work-shape/catalyst-server";
import { describe, expect, it } from "vitest";
import { RELEASED_KIT_VERSIONS } from "@work-shape/catalyst-app-build";
import * as kitClient from "@work-shape/catalyst-app-kit/client";
import {
  AppCallError,
  createAppClient,
  createFrameTransport,
  type Transport
} from "@work-shape/catalyst-app-kit/client";
import {
  BRIDGE_MARK,
  BRIDGE_VERSION,
  envelope,
  readHostMessage,
  type AppWorkflowRun,
  type HostMessage,
  type PageMessage
} from "@work-shape/catalyst-app-kit/protocol";

// The kit client is the Page's half of the bridge. It is written without a schema library,
// because its lines ship with every Page; the interface reads the same messages through the
// schemas of the API contract. These tests hold the two halves to each other and state what
// the client does before and after the interface answered.
// Every test here fails without the kit: the modules it reads did not exist.

const theme = {
  surfaceColor: "#ffffff",
  backgroundColor: "#f6f6f4",
  textColor: "#1b1b1a",
  mutedTextColor: "#6b6b68",
  borderColor: "#e3e3df",
  accentColor: "#2f6fed",
  accentStrongColor: "#1f4fb8"
};

const context = {
  viewer: { kind: "member", id: "user-1", displayName: "Anna Beispiel" },
  workspace: { id: "ws-1", name: "Finanzen" },
  locale: "de",
  theme,
  mode: "light",
  pageId: "page-1",
  fileSetNumber: 2,
  initialRoute: "/zahlen",
  // What the viewer may do with each named action of the Page.
  can: { load: "allow", save: "deny" }
} satisfies AppBridgeContext;

function hostMessage(message: HostMessage): unknown {
  return appBridgeHostMessageSchema.parse({ [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION, ...message });
}

/** A call is sent once the client knows its session, which is a turn after it was made. */
const sentCalls = () => new Promise((resolve) => setTimeout(resolve, 0));

function recordingTransport() {
  const sent: PageMessage[] = [];
  const listeners = new Set<(message: HostMessage) => void>();
  const transport: Transport = {
    send: (message) => {
      sent.push(message);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return {
    transport,
    sent,
    deliver(data: unknown) {
      const message = readHostMessage(data);
      if (message) {
        for (const listener of listeners) {
          listener(message);
        }
      }
    }
  };
}

describe("the two halves of the bridge", () => {
  it("mark their messages the same way", () => {
    expect([BRIDGE_MARK, BRIDGE_VERSION]).toEqual([APP_BRIDGE_MARK, APP_BRIDGE_VERSION]);
  });

  it("agree on what a Page sends: the interface accepts every message of the client", async () => {
    const { transport, sent, deliver } = recordingTransport();
    const client = createAppClient(transport);

    const asked = client.getContext();
    deliver(hostMessage({ type: "context", session: "session-1", context }));
    await asked;
    client.navigate("/zahlen/2026?monat=3");
    client.resize(812.5);
    void client.actions.call("load", { limit: 20 }, { idempotencyKey: "key-1" }).catch(() => 0);
    void client.workflowRuns.get("wfr-1").catch(() => 0);
    await sentCalls();

    expect(sent.map((message) => message.type)).toEqual([
      "ready",
      "navigate",
      "resize",
      "action",
      "workflow_run"
    ]);
    for (const message of sent) {
      expect(appBridgePageMessageSchema.safeParse(envelope(message)).success).toBe(true);
    }
  });

  // Fails before the removal: the kit offered `connections.call`, a free call of a Connection.
  it("offer no free call of a Connection: a Page reaches one through a named action", () => {
    const client = createAppClient(recordingTransport().transport);
    expect(Object.keys(client).sort()).toEqual([
      "actions",
      "getContext",
      "navigate",
      "onThemeChange",
      "resize",
      "workflowRuns"
    ]);
    expect("connections" in kitClient).toBe(false);
  });

  // Fails before kit 1.4.0: every released kit offered `connections.call` to a new Page.
  // Fails before kit 1.7.0: a call without the interface said only "The interface did not
  // answer.", and an agent added retries to the App for a fault of the host.
  // Fails before kit 1.8.0: a Page could not tell a test run its draft started (DP-1).
  it("ship kit 1.8.0 with personal JSON storage, without a free call of a Connection, naming the host's fault and test runs", () => {
    expect(RELEASED_KIT_VERSIONS.at(-1)).toBe("1.8.0");
    const kit = loadAppKitFiles().get("1.8.0")?.get("kit.js")?.bytes.toString("utf8");
    expect(kit).not.toMatch(/connection/u);
    expect(kit).toMatch(/\bas actions\b/u);
    expect(kit).toMatch(/\bas storage\b/u);
    expect(kit).toMatch(/trying again inside the App does not help/u);
    expect(kit).toMatch(/simulatedSteps/u);
  });

  it("agree on what the interface sends: the client reads what the schema allows", () => {
    expect(
      readHostMessage(hostMessage({ type: "context", session: "session-1", context }))
    ).toEqual({ type: "context", session: "session-1", context });
    expect(
      readHostMessage(
        hostMessage({ type: "context", session: "s", context: { ...context, workspace: null } })
      )
    ).toMatchObject({ context: { workspace: null } });
    expect(readHostMessage(hostMessage({ type: "theme", theme, mode: "dark" }))).toEqual({
      type: "theme",
      theme,
      mode: "dark"
    });
    // An interface that says nothing about actions leaves the Page with none it may call.
    const { can: _can, ...withoutCan } = context;
    expect(
      readHostMessage(
        appBridgeHostMessageSchema.parse({
          [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
          type: "context",
          session: "s",
          context: withoutCan
        })
      )
    ).toMatchObject({ context: { can: {} } });
    const done = {
      type: "action_result",
      session: "s",
      requestId: "1",
      ok: true,
      result: { runId: "run-1", status: "done", result: { rows: [1, 2] } }
    } as const;
    expect(readHostMessage(hostMessage(done))).toEqual(done);
    const refused = {
      type: "action_result",
      session: "s",
      requestId: "2",
      ok: false,
      error: { code: "forbidden", message: "Not allowed", right: "connection.use", runId: "run-2" }
    } as const;
    expect(readHostMessage(hostMessage(refused))).toEqual(refused);
  });

  it("reads nothing out of what is no message of the interface", () => {
    for (const data of [
      undefined,
      "context",
      { type: "context", session: "s", context },
      { [BRIDGE_MARK]: 2, type: "context", session: "s", context },
      {
        [BRIDGE_MARK]: BRIDGE_VERSION,
        type: "context",
        session: "s",
        context: { ...context, theme: {} }
      },
      { [BRIDGE_MARK]: BRIDGE_VERSION, type: "theme", theme, mode: "sepia" },
      { [BRIDGE_MARK]: BRIDGE_VERSION, type: "run", code: "0" }
    ]) {
      expect(readHostMessage(data)).toBeUndefined();
    }
  });
});

describe("the kit client", () => {
  it("asks once and gives every caller the same context", async () => {
    const { transport, sent, deliver } = recordingTransport();
    const client = createAppClient(transport);

    const first = client.getContext();
    const second = client.getContext();
    deliver(hostMessage({ type: "context", session: "session-1", context }));

    expect(await first).toEqual(context);
    expect(await second).toEqual(context);
    expect(sent).toEqual([{ type: "ready" }]);
  });

  it("holds what the Page says before the interface answered and sends the newest of each kind with the session", async () => {
    const { transport, sent, deliver } = recordingTransport();
    const client = createAppClient(transport);

    client.navigate("/a");
    client.navigate("/b");
    client.resize(400);
    expect(sent).toEqual([{ type: "ready" }]);

    deliver(hostMessage({ type: "context", session: "session-1", context }));
    await client.getContext();

    expect(sent.slice(1)).toEqual([
      { type: "navigate", session: "session-1", path: "/b" },
      { type: "resize", session: "session-1", height: 400 }
    ]);
  });

  it("keeps the session of the first answer", async () => {
    const { transport, sent, deliver } = recordingTransport();
    const client = createAppClient(transport);

    const asked = client.getContext();
    deliver(hostMessage({ type: "context", session: "session-1", context }));
    deliver(
      hostMessage({ type: "context", session: "session-2", context: { ...context, locale: "en" } })
    );
    client.navigate("/a");

    expect((await asked).locale).toBe("de");
    expect(sent.at(-1)).toEqual({ type: "navigate", session: "session-1", path: "/a" });
  });

  it("tells a theme change to every listener until it stops listening", async () => {
    const { transport, deliver } = recordingTransport();
    const client = createAppClient(transport);
    const seen: string[] = [];

    const stop = client.onThemeChange((change) => seen.push(change.mode));
    deliver(hostMessage({ type: "context", session: "session-1", context }));
    await client.getContext();
    deliver(hostMessage({ type: "theme", theme, mode: "dark" }));
    stop();
    deliver(hostMessage({ type: "theme", theme, mode: "light" }));

    expect(seen).toEqual(["dark"]);
  });

  it("sends one call with an id of its own and gives the caller the answer that names it", async () => {
    const { transport, sent, deliver } = recordingTransport();
    const client = createAppClient(transport);
    const asked = client.getContext();
    deliver(hostMessage({ type: "context", session: "session-1", context }));
    await asked;

    const first = client.actions.call("load", { limit: 20 });
    const second = client.actions.call("save", { note: "x" }, { idempotencyKey: "key-1" });
    await sentCalls();
    const calls = sent.filter((message) => message.type === "action");

    expect(calls).toEqual([
      {
        type: "action",
        session: "session-1",
        requestId: expect.any(String),
        name: "load",
        input: { limit: 20 }
      },
      {
        type: "action",
        session: "session-1",
        requestId: expect.any(String),
        name: "save",
        input: { note: "x" },
        idempotencyKey: "key-1"
      }
    ]);
    const [load, save] = calls;
    if (!load || !save) throw new Error("Two calls were sent");
    expect(load.requestId).not.toBe(save.requestId);
    // The answers arrive in the other order, and one of another session arrives first.
    deliver(
      hostMessage({
        type: "action_result",
        session: "session-2",
        requestId: load.requestId,
        ok: true,
        result: { runId: "run-0", status: "done" }
      })
    );
    deliver(
      hostMessage({
        type: "action_result",
        session: "session-1",
        requestId: save.requestId,
        ok: false,
        error: {
          code: "forbidden",
          message: "Not allowed",
          right: "connection.use",
          retryable: false,
          runId: "run-9"
        }
      })
    );
    deliver(
      hostMessage({
        type: "action_result",
        session: "session-1",
        requestId: load.requestId,
        ok: true,
        result: { runId: "run-1", status: "done", result: { rows: [1] } }
      })
    );

    expect(await first).toEqual({ runId: "run-1", status: "done", result: { rows: [1] } });
    const refused = await second.catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppCallError);
    // Fails without the fix round: the kit read no `retryable`, so a page could not tell a
    // refusal that trying again cannot change. The sentence is the interface's, as it is.
    expect(refused).toMatchObject({
      code: "forbidden",
      message: "Not allowed",
      right: "connection.use",
      retryable: false,
      runId: "run-9"
    });
    // A failure that says nothing of it may be tried again.
    expect(new AppCallError({ code: "failed", message: "x" }).retryable).toBe(true);
  });

  it("reads a Workflow Run an action started and the answer of a draft, under the id it gave", async () => {
    const { transport, sent, deliver } = recordingTransport();
    const client = createAppClient(transport);
    const asked = client.getContext();
    deliver(hostMessage({ type: "context", session: "session-1", context }));
    await asked;

    const tried = client.actions.call("log-visit", { page: "/draft" });
    const read = client.workflowRuns.get("wfr_1");
    const missing = client.workflowRuns.get("wfr_2");
    await sentCalls();
    const [action, run, other] = sent.slice(1);
    if (action?.type !== "action" || run?.type !== "workflow_run" || other?.type !== "workflow_run")
      throw new Error("An action and two reads of a run were sent");
    expect(run).toEqual({
      type: "workflow_run",
      session: "session-1",
      requestId: expect.any(String),
      runId: "wfr_1"
    });
    for (const message of [run, other]) {
      expect(appBridgePageMessageSchema.safeParse(envelope(message)).success).toBe(true);
    }
    // A draft starts nothing and says what it would have started.
    const dryRun = {
      status: "dry_run",
      message: "Would have started the Workflow 'visit-log' with {}.",
      result: { workflow: "visit-log", input: {} }
    } as const;
    deliver(
      hostMessage({
        type: "action_result",
        session: "session-1",
        requestId: action.requestId,
        ok: true,
        result: dryRun
      })
    );
    const ended: AppWorkflowRun = {
      id: "wfr_1",
      workflow: "visit-log",
      status: "done",
      output: { page: "/pricing" },
      startedAt: "2026-10-13T10:00:00.000Z",
      finishedAt: "2026-10-13T10:00:01.000Z",
      // A run a click in a draft started says it is a test, of which Workflow revision, and
      // which steps were simulated; kit 1.7.0 dropped these.
      mode: "test",
      workflowRevision: { kind: "draft", number: 7 },
      simulatedSteps: ["notify"]
    };
    // An answer of another kind under the id of a read is no answer to it.
    deliver(
      hostMessage({
        type: "action_result",
        session: "session-1",
        requestId: other.requestId,
        ok: true,
        result: { runId: "run-1", status: "done" }
      })
    );
    deliver(
      hostMessage({
        type: "workflow_run_result",
        session: "session-1",
        requestId: run.requestId,
        ok: true,
        run: ended
      })
    );

    expect(await tried).toEqual(dryRun);
    expect(await read).toEqual(ended);
    await expect(missing).rejects.toMatchObject({ name: "AppCallError" });
  });

  it("ends a call nothing answers", async () => {
    const { transport, deliver } = recordingTransport();
    const client = createAppClient(transport, { callTimeoutMs: 5 });
    const asked = client.getContext();
    deliver(hostMessage({ type: "context", session: "session-1", context }));
    await asked;

    await expect(client.actions.call("load", {})).rejects.toMatchObject({
      name: "AppCallError",
      code: "timeout"
    });
  });

  it("refuses a call as a call when no interface answers", async () => {
    const { transport } = recordingTransport();
    const client = createAppClient(transport, { contextTimeoutMs: 5 });

    // AGENT-FRICTION-1: the message says the host is at fault and that trying again in the
    // App does not help, and the error is not retryable, so no App offers a retry for it.
    await expect(client.actions.call("load")).rejects.toMatchObject({
      name: "AppCallError",
      code: "not_connected",
      retryable: false,
      message: expect.stringContaining("not of the App: trying again inside the App does not help")
    });
  });

  it("says so when no interface answers", async () => {
    const { transport } = recordingTransport();
    const client = createAppClient(transport, { contextTimeoutMs: 5 });

    await expect(client.getContext()).rejects.toThrow(
      "The interface that shows this App did not answer it."
    );
  });
});

describe("the transport of a Page in a frame", () => {
  function windows() {
    const posted: { to: string; message: unknown; targetOrigin: string }[] = [];
    const windowNamed = (name: string, parent?: object) => {
      const self = {
        parent: undefined as unknown,
        postMessage(message: unknown, targetOrigin: string) {
          posted.push({ to: name, message, targetOrigin });
        }
      };
      self.parent = parent ?? self;
      return self;
    };
    const top = windowNamed("top");
    const interfaceWindow = windowNamed("interface", top);
    const holder = windowNamed("holder", interfaceWindow);
    type Arrived = { data: unknown; origin: string; source: unknown };
    const listeners = new Set<(event: Arrived) => void>();
    // What the kit reads of the Page's own window: its parent and its listeners, nothing else.
    const page = {
      parent: holder,
      addEventListener: (_type: "message", listener: (event: Arrived) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: "message", listener: (event: Arrived) => void) => {
        listeners.delete(listener);
      }
    };
    const arrive = (source: object, origin: string, data: unknown) => {
      for (const listener of listeners) {
        listener({ data, origin, source });
      }
    };
    return { posted, top, interfaceWindow, holder, page, arrive, listeners };
  }

  it("greets the two windows above it without content and no window further up", () => {
    const { page, posted } = windows();
    const transport = createFrameTransport(page);

    transport.send({ type: "ready" });

    expect(posted).toEqual([
      { to: "holder", message: envelope({ type: "ready" }), targetOrigin: "*" },
      { to: "interface", message: envelope({ type: "ready" }), targetOrigin: "*" }
    ]);
  });

  it("says nothing more until a window answered, then speaks to that window at its origin only", () => {
    const { page, posted, interfaceWindow, arrive } = windows();
    const transport = createFrameTransport(page);
    const seen: HostMessage[] = [];
    transport.subscribe((message) => seen.push(message));

    transport.send({ type: "navigate", session: "s", path: "/a" });
    expect(posted).toEqual([]);

    arrive(
      interfaceWindow,
      "https://chat.example.test",
      hostMessage({ type: "context", session: "s", context })
    );
    transport.send({ type: "navigate", session: "s", path: "/a" });

    expect(seen.map((message) => message.type)).toEqual(["context"]);
    expect(posted).toEqual([
      {
        to: "interface",
        message: envelope({ type: "navigate", session: "s", path: "/a" }),
        targetOrigin: "https://chat.example.test"
      }
    ]);
  });

  it("takes messages from the windows above it only, and after the answer from that one window", () => {
    const { page, top, holder, interfaceWindow, arrive } = windows();
    const transport = createFrameTransport(page);
    const seen: HostMessage[] = [];
    transport.subscribe((message) => seen.push(message));
    const answer = hostMessage({ type: "context", session: "s", context });
    const change = hostMessage({ type: "theme", theme, mode: "dark" });

    arrive(top, "https://chat.example.test", answer);
    arrive({ postMessage() {} }, "https://chat.example.test", answer);
    expect(seen).toEqual([]);

    arrive(interfaceWindow, "https://chat.example.test", answer);
    arrive(holder, "https://chat.example.test", change);
    expect(seen.map((message) => message.type)).toEqual(["context"]);

    arrive(interfaceWindow, "https://chat.example.test", change);
    expect(seen.map((message) => message.type)).toEqual(["context", "theme"]);
  });

  it("stops listening when asked", () => {
    const { page, listeners } = windows();
    const stop = createFrameTransport(page).subscribe(() => undefined);

    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });
});
