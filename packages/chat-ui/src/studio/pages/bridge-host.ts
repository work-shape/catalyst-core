import {
  APP_BRIDGE_CONNECTION_CALL_REMOVED,
  APP_BRIDGE_MARK,
  APP_BRIDGE_VERSION,
  appBridgeHostMessageSchema,
  appBridgePageMessageSchema,
  type AppBridgeContext,
  type AppBridgeGuardReport,
  type AppBridgeHostMessage,
  type AppBridgePageMessage
} from "@work-shape/catalyst-api-client";
import type {
  FrameCallAnswer,
  FrameCalls,
  FrameTestRun,
  FrameWorkflowRunAnswer
} from "./frame-calls";

// The interface's side of the bridge to a Page. A Page is code an agent wrote, running in a
// frame without an origin. So the interface decides by three things whether it listens: the
// window a message came from, its shape, and the session it names.
//
// The instance serves a Page inside a holding document of its own: the frame of the interface
// shows that document, and the Page is the one frame inside it. A message of the Page
// therefore comes from the only child window of the frame's window, and from no origin.

/** The origin a message from a sandboxed frame carries. */
const OPAQUE_ORIGIN = "null";

/** What the bridge reads of a window: its child frames, by number. */
export interface FrameTree {
  readonly length: number;
  readonly [index: number]: unknown;
}

/** A message as it arrived, before anything is known about it. */
export interface ArrivedMessage {
  data: unknown;
  origin: string;
  source: unknown;
}

/**
 * The message of the Page shown in `frame`, or nothing. A message counts when it came from the
 * one frame inside the holding document, carries no origin, has exactly the shape of a bridge
 * message, and, unless it is the greeting or the guard's report, names `session`.
 */
export function readPageMessage(
  event: ArrivedMessage,
  frame: FrameTree | null | undefined,
  session: string
): AppBridgePageMessage | undefined {
  if (!frame || event.source === null || event.source === undefined) {
    return undefined;
  }
  if (event.origin !== OPAQUE_ORIGIN || frame.length !== 1 || frame[0] !== event.source) {
    return undefined;
  }
  const parsed = appBridgePageMessageSchema.safeParse(event.data);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.type === "ready" ||
    parsed.data.type === "report" ||
    parsed.data.session === session
    ? parsed.data
    : undefined;
}

/** The answer to a Page's greeting. */
export function contextMessage(session: string, context: AppBridgeContext): AppBridgeHostMessage {
  return appBridgeHostMessageSchema.parse({
    [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
    type: "context",
    session,
    context
  });
}

/** What tells a Page that the colours or the mode of the interface changed. */
export function themeMessage(look: Pick<AppBridgeContext, "theme" | "mode">): AppBridgeHostMessage {
  return appBridgeHostMessageSchema.parse({
    [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
    type: "theme",
    theme: look.theme,
    mode: look.mode
  });
}

/** The answer to one call of a Page, named by the id the Page gave the call. */
export function callResultMessage(
  session: string,
  requestId: string,
  answer: FrameCallAnswer
): AppBridgeHostMessage {
  return appBridgeHostMessageSchema.parse({
    [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
    type: "action_result",
    session,
    requestId,
    ...answer
  });
}

/** The answer to one read of a Workflow Run, named by the id the Page gave the read. */
export function workflowRunResultMessage(
  session: string,
  requestId: string,
  answer: FrameWorkflowRunAnswer
): AppBridgeHostMessage {
  return appBridgeHostMessageSchema.parse({
    [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
    type: "workflow_run_result",
    session,
    requestId,
    ...answer
  });
}

/**
 * The id of the Workflow Run a call answered when that run is a test run (DP-1): a draft's
 * `workflow` action answers the run `workflows.test` started.
 */
function testRunStarted(
  answer: Extract<FrameCallAnswer, { ok: true }>["result"]
): string | undefined {
  if (answer.status !== "done") return undefined;
  const run: unknown = answer.result;
  return typeof run === "object" &&
    run !== null &&
    "mode" in run &&
    run.mode === "test" &&
    "id" in run &&
    typeof run.id === "string"
    ? run.id
    : undefined;
}

/** What a Page is told where no call can be made, and where a call got no answer. */
const NOT_AVAILABLE = { code: "not_available", message: "This frame cannot make calls." };
const NOT_MADE = { code: "failed", message: "The call could not be made." };

interface PageWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

function isPageWindow(value: unknown): value is PageWindow {
  return typeof value === "object" && value !== null && "postMessage" in value;
}

/** The interface's end of one mounted Page frame. */
export interface PageBridge {
  /** Takes one message that arrived at the interface's window. */
  receive(event: ArrivedMessage): void;
  /** Tells the Page the look of the interface, once the Page has greeted. */
  sendLook(look: Pick<AppBridgeContext, "theme" | "mode">): void;
}

/**
 * The bridge of one frame. `frame` is asked on every message, because the frame's window is
 * replaced when the frame loads another document. A sandboxed frame has no origin to post to,
 * so answers go to the window that was just checked, with any origin as the target.
 */
export function createPageBridge(input: {
  frame(): FrameTree | null | undefined;
  session: string;
  /** The context as it is when the Page asks. */
  context(): AppBridgeContext;
  onNavigate(path: string): void;
  onResize(height: number): void;
  /**
   * How the calls of the Page reach the instance, asked when a call arrives. Without it the
   * Page is told that no call can be made, and its context names no action.
   */
  calls?(): FrameCalls | undefined;
  /**
   * A call of the Page was answered that it waits for an approval, under this run. The host
   * says so over the frame: the Page is told only the answer.
   */
  onCallWaits?(runId: string): void;
  /**
   * A call of the draft started a test run of a Workflow, or a read of the Page answered one
   * (DP-1), as it stands now. The host marks it over the frame: the Page need not.
   */
  onTestRun?(run: FrameTestRun): void;
  /** The Page greeted: its kit is there (PREVIEW-STATUS-1). */
  onGreeted?(): void;
  /** The platform's guard in the Page reported what the Page did (PREVIEW-STATUS-1). */
  onReport?(report: AppBridgeGuardReport): void;
  /** A call of the Page failed, by the name it called and the code it was answered. */
  onCallFailed?(name: string, code: string): void;
}): PageBridge {
  let page: PageWindow | undefined;
  let storageWrites = Promise.resolve();
  /**
   * Posts to the window that sent a message, while it is still the frame's one child. Says
   * whether it was.
   */
  const post = (to: PageWindow, message: AppBridgeHostMessage): boolean => {
    const frame = input.frame();
    if (frame?.length === 1 && frame[0] === to) {
      to.postMessage(message, "*");
      return true;
    }
    return false;
  };
  /** Tells the host of a test run a read answered. */
  const noteTestRun = (answer: FrameWorkflowRunAnswer) => {
    if (answer.ok && answer.run.mode === "test") {
      input.onTestRun?.({ ...answer.run, mode: "test" });
    }
  };
  return {
    receive(event) {
      const message = readPageMessage(event, input.frame(), input.session);
      const source: unknown = event.source;
      if (!message || !isPageWindow(source)) {
        return;
      }
      if (message.type === "report") {
        input.onReport?.(message.report);
        return;
      }
      if (message.type === "ready") {
        page = source;
        input.onGreeted?.();
        const calls = input.calls?.();
        if (!calls) {
          source.postMessage(contextMessage(input.session, input.context()), "*");
          return;
        }
        // The context waits for what the viewer may do. A read that fails leaves it out.
        calls
          .can()
          .catch(() => undefined)
          .then((can) => {
            post(
              source,
              contextMessage(input.session, {
                ...input.context(),
                ...(can === undefined ? {} : { can })
              })
            );
          })
          // The frame was replaced while the answer was on its way: nobody is left to tell.
          .catch(() => undefined);
      } else if (message.type === "storage_write") {
        // A synchronous localStorage call still arrives in order. Wait for each durable
        // write before starting the next, including after a refusal.
        const calls = input.calls?.();
        storageWrites = storageWrites
          .then(async () => {
            let ok = false;
            try {
              if (calls) {
                await calls.writeStorage(message.mutation);
                ok = true;
              }
            } catch {
              /* The App receives a fixed failure, never server text or credentials. */
            }
            post(source, {
              [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
              type: "storage_result",
              session: input.session,
              requestId: message.requestId,
              ok
            });
          })
          .catch(() => undefined);
      } else if (message.type === "navigate") {
        input.onNavigate(message.path);
      } else if (message.type === "resize") {
        input.onResize(message.height);
      } else if (message.type === "workflow_run") {
        const { requestId } = message;
        const calls = input.calls?.();
        const answer: Promise<FrameWorkflowRunAnswer> = calls
          ? calls.workflowRun(message.runId)
          : Promise.resolve({ ok: false, error: NOT_AVAILABLE });
        answer
          // The Page always gets an answer to a read, so that it never waits for nothing.
          .catch((): FrameWorkflowRunAnswer => ({ ok: false, error: NOT_MADE }))
          .then((result) => {
            if (post(source, workflowRunResultMessage(input.session, requestId, result))) {
              noteTestRun(result);
            }
          })
          .catch(() => undefined);
      } else if (message.type === "connection_call") {
        // Retired: a Page of an older kit is told at once that a named action is the way.
        input.onCallFailed?.(
          `${message.connection}.${message.operation}`,
          APP_BRIDGE_CONNECTION_CALL_REMOVED.code
        );
        post(
          source,
          callResultMessage(input.session, message.requestId, {
            ok: false,
            error: { ...APP_BRIDGE_CONNECTION_CALL_REMOVED }
          })
        );
      } else {
        const { requestId } = message;
        const calls = input.calls?.();
        const answer: Promise<FrameCallAnswer> = calls
          ? calls.run(message)
          : Promise.resolve({ ok: false, error: NOT_AVAILABLE });
        answer
          // The Page always gets an answer to a call, so that it never waits for nothing.
          .catch((): FrameCallAnswer => ({ ok: false, error: NOT_MADE }))
          .then((result) => {
            if (!result.ok) input.onCallFailed?.(message.name, result.error.code);
            const told = post(source, callResultMessage(input.session, requestId, result));
            // A frame that was replaced meanwhile has nobody waiting on the call.
            if (
              told &&
              result.ok &&
              "runId" in result.result &&
              result.result.status === "pending_approval"
            ) {
              input.onCallWaits?.(result.result.runId);
            }
            // A test run the draft started is read once at once, for which revision ran; the
            // Page's own reads of it tell the rest.
            const started = told && result.ok ? testRunStarted(result.result) : undefined;
            if (started !== undefined && calls) {
              calls
                .workflowRun(started)
                .then(noteTestRun)
                .catch(() => undefined);
            }
          })
          .catch(() => undefined);
      }
    },
    sendLook(look) {
      const frame = input.frame();
      // The Page that greeted is told, and only while it is still the frame's one child.
      if (page && frame?.length === 1 && frame[0] === page) {
        page.postMessage(themeMessage(look), "*");
      }
    }
  };
}
