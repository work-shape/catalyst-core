import {
  APP_BRIDGE_MARK,
  APP_BRIDGE_VERSION,
  appBridgeHostMessageSchema,
  appBridgePageMessageSchema,
  type AppBridgeContext,
  type AppBridgeHostMessage,
  type AppBridgePageMessage
} from "@vivd-catalyst/api-client";

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
 * message, and, unless it is the greeting, names `session`.
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
  return parsed.data.type === "ready" || parsed.data.session === session ? parsed.data : undefined;
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
}): PageBridge {
  let page: PageWindow | undefined;
  return {
    receive(event) {
      const message = readPageMessage(event, input.frame(), input.session);
      if (!message || !isPageWindow(event.source)) {
        return;
      }
      if (message.type === "ready") {
        page = event.source;
        page.postMessage(contextMessage(input.session, input.context()), "*");
      } else if (message.type === "navigate") {
        input.onNavigate(message.path);
      } else {
        input.onResize(message.height);
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
