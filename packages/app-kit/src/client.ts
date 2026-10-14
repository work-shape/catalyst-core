import {
  envelope,
  readHostMessage,
  type AppCallFailure,
  type AppCallResult,
  type AppContext,
  type AppThemeChange,
  type AppWorkflowRun,
  type HostMessage,
  type PageMessage
} from "./protocol";

// The kit client: what a Page calls to learn where it runs and to tell the interface where it
// is. The client talks through a transport. Inside a frame the transport is `postMessage`;
// app code never calls that itself, and never names `window.parent` or the instance address.

/** How the client reaches the interface. */
export interface Transport {
  /** Sends one message of the Page. */
  send(message: PageMessage): void;
  /** Calls `listener` for every message of the interface until the returned function is called. */
  subscribe(listener: (message: HostMessage) => void): () => void;
}

/** The longest a Page waits for the interface to answer its first message. */
const CONTEXT_TIMEOUT_MS = 10_000;
/**
 * The longest a Page waits for the answer to one call. The instance ends a call of a
 * Connection earlier, so a call that runs into this was lost on the way.
 */
const CALL_TIMEOUT_MS = 180_000;

/**
 * A call that was refused or failed. `code` says why in a fixed word. `message` is the
 * platform's sentence for the person who looks at the page, in that person's language where
 * the platform has one: show it as it is and do not word a refusal yourself.
 */
export class AppCallError extends Error {
  override readonly name = "AppCallError";
  readonly code: string;
  /** The right a `forbidden` call lacks. */
  readonly right?: string;
  /**
   * `false` where the same call again cannot come out differently, such as a missing right.
   * Offer no button to try again then.
   */
  readonly retryable: boolean;
  readonly runId?: string;

  constructor(failure: AppCallFailure) {
    super(failure.message);
    this.code = failure.code;
    if (failure.right !== undefined) this.right = failure.right;
    this.retryable = failure.retryable !== false;
    if (failure.runId !== undefined) this.runId = failure.runId;
  }
}

/** What an answer of the wrong kind to a request is taken as. The interface sends none. */
const MISMATCHED_ANSWER = { code: "failed", message: "The interface answered another call." };

/** What one call may carry beside its input. */
export interface AppCallOptions {
  /**
   * Names one changing call, so that sending it twice carries it out once. A changing action
   * of a published App needs one. Make it when the person acts, and send the same one again
   * when the answer was lost.
   */
  idempotencyKey?: string;
}

interface MessageSource {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** What the transport reads of a message that arrived. */
interface ArrivedMessage {
  data: unknown;
  origin: string;
  source: unknown;
}

interface FrameWindow {
  parent: unknown;
  addEventListener(type: "message", listener: (event: ArrivedMessage) => void): void;
  removeEventListener(type: "message", listener: (event: ArrivedMessage) => void): void;
}

/**
 * The window of this Page, as the transport reads it. A Page that is no frame is its own
 * parent: its greeting comes back to it and is no message of an interface, so nothing answers.
 * The transport reads `parent` and nothing else of it, so that a test can stand in for it.
 */
function pageWindow(): FrameWindow {
  return {
    parent: window.parent,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener)
  };
}

/**
 * The windows that may be the interface: the one that holds the Page's frame and the one above
 * it. The instance serves a Page inside a holding document of its own, so the interface is the
 * second; a Page framed directly finds it as the first.
 */
function hostCandidates(self: FrameWindow): MessageSource[] {
  const candidates: MessageSource[] = [];
  let current: unknown = self.parent;
  for (let level = 0; level < 2 && isWindowLike(current); level += 1) {
    candidates.push(current);
    const above: unknown = current.parent;
    // The window at the top is its own parent.
    if (above === current) {
      break;
    }
    current = above;
  }
  return candidates;
}

function isWindowLike(value: unknown): value is MessageSource & { parent: unknown } {
  return typeof value === "object" && value !== null && "postMessage" in value;
}

/**
 * The transport of a Page in a frame. The first message is a greeting without content and goes
 * to the windows above the frame. The window that answers it with the context is the
 * interface: from then on the Page posts to that window and to the origin it answered from,
 * and takes messages from that window only.
 */
export function createFrameTransport(self: FrameWindow = pageWindow()): Transport {
  const candidates = hostCandidates(self);
  let host: { source: MessageSource; origin: string } | undefined;
  return {
    send(message) {
      if (message.type === "ready") {
        for (const candidate of candidates) {
          candidate.postMessage(envelope(message), "*");
        }
        return;
      }
      host?.source.postMessage(envelope(message), host.origin);
    },
    subscribe(listener) {
      const onMessage = (event: ArrivedMessage) => {
        const source: unknown = event.source;
        const known = host ? source === host.source : candidates.some((item) => item === source);
        if (!known) {
          return;
        }
        const message = readHostMessage(event.data);
        if (!message) {
          return;
        }
        if (!host && message.type === "context" && isWindowLike(source)) {
          host = { source, origin: event.origin };
        }
        listener(message);
      };
      self.addEventListener("message", onMessage);
      return () => self.removeEventListener("message", onMessage);
    }
  };
}

export interface AppClient {
  /** Where the Page runs and who looks at it. Asked once; every later call gets the same answer. */
  getContext(): Promise<AppContext>;
  /** Calls `callback` when the interface changes its colours or its mode. Returns the way to stop. */
  onThemeChange(callback: (change: AppThemeChange) => void): () => void;
  /** Tells the interface which route the Page shows. A router made by the kit calls it itself. */
  navigate(path: string): void;
  /** Tells the interface how high the Page's content is, in pixels. */
  resize(height: number): void;
  actions: {
    /**
     * Calls a named action of the manifest with the viewer's rights. A call that is refused
     * or fails rejects with an `AppCallError`.
     */
    call(
      name: string,
      params?: Record<string, unknown>,
      options?: AppCallOptions
    ): Promise<AppCallResult>;
  };
  workflowRuns: {
    /**
     * Reads a Workflow Run that an action of this Page started, by the `id` of the run the
     * call answered: its state and, once it is done, its result. A run of a Workflow that no
     * action of the manifest starts rejects with an `AppCallError` as one that does not exist.
     */
    get(runId: string): Promise<AppWorkflowRun>;
  };
}

type RequestMessage = Extract<PageMessage, { type: "action" | "workflow_run" }>;
/** A call or a read before the session and the id of its answer are known. */
type NewRequest =
  | Omit<Extract<RequestMessage, { type: "action" }>, "session" | "requestId">
  | Omit<Extract<RequestMessage, { type: "workflow_run" }>, "session" | "requestId">;
type Answer = Extract<HostMessage, { type: "action_result" | "workflow_run_result" }>;

/** A client on a transport. A Page uses the one below; a test brings its own transport. */
export function createAppClient(
  transport: Transport,
  options: { contextTimeoutMs?: number; callTimeoutMs?: number } = {}
): AppClient {
  let session: string | undefined;
  let context: Promise<AppContext> | undefined;
  const themeListeners = new Set<(change: AppThemeChange) => void>();
  // What the Page said before the interface answered: the newest message of each kind.
  const pending = new Map<PageMessage["type"], PageMessage>();
  // The calls and reads that wait for their answer, by the id each was sent with.
  const calls = new Map<
    string,
    {
      resolve(answer: Answer): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  let callCount = 0;

  function connect(): Promise<AppContext> {
    context ??= new Promise<AppContext>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("The interface did not answer. A Page runs inside the platform."));
      }, options.contextTimeoutMs ?? CONTEXT_TIMEOUT_MS);
      transport.subscribe((incoming) => {
        if (incoming.type === "context") {
          if (session === undefined) {
            session = incoming.session;
            clearTimeout(timeout);
            resolve(incoming.context);
            const queued = [...pending.values()];
            pending.clear();
            for (const message of queued) {
              send(message);
            }
          }
          return;
        }
        if (incoming.type === "action_result" || incoming.type === "workflow_run_result") {
          const waiting = incoming.session === session ? calls.get(incoming.requestId) : undefined;
          if (!waiting) {
            return;
          }
          calls.delete(incoming.requestId);
          clearTimeout(waiting.timeout);
          waiting.resolve(incoming);
          return;
        }
        for (const listener of themeListeners) {
          listener({ theme: incoming.theme, mode: incoming.mode });
        }
      });
      transport.send({ type: "ready" });
    });
    return context;
  }

  /** A message sent before the interface answered waits for the session it has to carry. */
  function send(message: PageMessage): void {
    if (session === undefined) {
      pending.set(message.type, message);
      void connect().catch(() => undefined);
      return;
    }
    transport.send(message.type === "ready" ? message : { ...message, session });
  }

  /** Sends one call or read once the interface answered, and waits for the answer that names it. */
  async function request(message: NewRequest): Promise<Answer> {
    await connect().catch(() => undefined);
    const callSession = session;
    if (callSession === undefined) {
      throw new AppCallError({ code: "not_connected", message: "The interface did not answer." });
    }
    callCount += 1;
    const requestId = `${callCount}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<Answer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        calls.delete(requestId);
        reject(
          new AppCallError({ code: "timeout", message: "The interface did not answer the call." })
        );
      }, options.callTimeoutMs ?? CALL_TIMEOUT_MS);
      calls.set(requestId, { resolve, timeout });
      transport.send({ ...message, session: callSession, requestId });
    });
  }

  async function call(
    message: Exclude<NewRequest, { type: "workflow_run" }>
  ): Promise<AppCallResult> {
    const answer = await request(message);
    if (answer.type === "action_result" && answer.ok) return answer.result;
    throw new AppCallError(answer.ok ? MISMATCHED_ANSWER : answer.error);
  }

  return {
    getContext: connect,
    actions: {
      call: (name, params = {}, callOptions = {}) =>
        call({
          type: "action",
          name,
          input: params,
          ...(callOptions.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: callOptions.idempotencyKey })
        })
    },
    workflowRuns: {
      async get(runId) {
        const answer = await request({ type: "workflow_run", runId });
        if (answer.type === "workflow_run_result" && answer.ok) return answer.run;
        throw new AppCallError(answer.ok ? MISMATCHED_ANSWER : answer.error);
      }
    },
    onThemeChange(callback) {
      themeListeners.add(callback);
      void connect().catch(() => undefined);
      return () => {
        themeListeners.delete(callback);
      };
    },
    navigate(path) {
      send({ type: "navigate", session: "", path });
    },
    resize(height) {
      send({ type: "resize", session: "", height });
    }
  };
}

let frameClient: AppClient | undefined;

/** The client of this Page. It is made with the first call, so importing the kit sends nothing. */
function client(): AppClient {
  frameClient ??= createAppClient(createFrameTransport());
  return frameClient;
}

export const getContext: AppClient["getContext"] = () => client().getContext();
export const onThemeChange: AppClient["onThemeChange"] = (callback) =>
  client().onThemeChange(callback);
export const navigate: AppClient["navigate"] = (path) => client().navigate(path);
export const resize: AppClient["resize"] = (height) => client().resize(height);
/** The named actions of the manifest. `actions.call("loadRows", { limit: 20 })`. */
export const actions: AppClient["actions"] = {
  call: (name, params, options) => client().actions.call(name, params, options)
};
/** The Workflow Runs the actions of the manifest started. `workflowRuns.get(run.id)`. */
export const workflowRuns: AppClient["workflowRuns"] = {
  get: (runId) => client().workflowRuns.get(runId)
};
