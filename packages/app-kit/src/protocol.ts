// The messages between a Page and the interface that shows it. The Page's side is written
// here, without a schema library, because these lines ship in the kit file every Page loads.
// The interface validates what a Page sends against the schemas of
// `@work-shape/catalyst-api-contract` (`app-bridge.ts`); `tests/app-kit-client.test.ts` holds the
// two descriptions to each other.

/** Marks a message of this bridge, with the version of its shape. */
export const BRIDGE_MARK = "catalystBridge";
export const BRIDGE_VERSION = 1;

/** The seven colours an instance sets per mode. */
export interface AppTheme {
  surfaceColor: string;
  backgroundColor: string;
  textColor: string;
  mutedTextColor: string;
  borderColor: string;
  accentColor: string;
  accentStrongColor: string;
}

export type AppThemeMode = "light" | "dark";

/**
 * What a call of an action would come to for the viewer now: it runs, it runs as the viewer's
 * own confirmation, it waits for another person's approval, or it is refused. The interface
 * computes it. It is a hint for what to show, and the call itself is checked when it is made.
 */
export type AppActionPermission = "allow" | "confirm" | "approval" | "deny";

/** What a Page knows about where it runs and who looks at it. */
export interface AppContext {
  /** The person the Page is shown to. `member` is the only kind today. */
  viewer: { kind: "member"; id: string; displayName: string };
  /** The workspace of the conversation, where the interface knows it. */
  workspace: { id: string; name: string } | null;
  /** The interface language, such as `de` or `en`. */
  locale: string;
  theme: AppTheme;
  mode: AppThemeMode;
  pageId: string;
  /** The revision of the Page that is shown, counted from 1. */
  fileSetNumber: number;
  /** The route the Page starts on. */
  initialRoute: string;
  /** Per named action of the manifest. Empty where the interface told none. */
  can: Record<string, AppActionPermission>;
}

/**
 * How a call went. `pending_approval` carries no result: the call waits for another person.
 * `dry_run` is the answer of a draft or a Page to an action that would change something, such
 * as one that starts a Workflow: nothing was carried out and no run was made; `message` is the
 * platform's sentence of what the call would have done, and `result` the input it would have
 * done it with. Show the message as it is.
 */
export type AppCallResult =
  | {
      runId: string;
      status: "done" | "pending_approval";
      /**
       * What the operation answered. Check its shape before using it. Of an action that starts
       * a Workflow it is the Workflow Run, with its `id`: follow it with `useWorkflowRun`.
       */
      result?: unknown;
    }
  | { status: "dry_run"; message: string; result: unknown };

/** The states of a Workflow Run. The first three wait for more; the others are its end. */
export type AppWorkflowRunStatus =
  "queued" | "running" | "waiting" | "done" | "failed" | "cancelled" | "limit_reached";

/** A Workflow Run that an action of this Page started, as it stands now. */
export interface AppWorkflowRun {
  id: string;
  workflow: string;
  status: AppWorkflowRunStatus;
  /**
   * What the run answered, once it is `done`, whole. A result of more than 256 KiB as JSON
   * is not handed to a Page: `outputTruncated` says so, and the Page reads what it needs from
   * where the Workflow wrote it, such as a Data Store.
   */
  output?: unknown;
  outputTruncated?: boolean;
  /** Why the run did not end `done`: a fixed word and the platform's sentence. */
  error?: { code: string; message: string };
  startedAt?: string;
  finishedAt?: string;
  /**
   * `test` on a run a click in the App's draft started: it ran as a test, and nothing of it is
   * live. Missing on a run of a published App.
   */
  mode?: "test";
  /**
   * On a test run: the revision of the Workflow that ran, its draft or its published one, with
   * its number while that revision is still the draft or the published one.
   */
  workflowRevision?: { kind: "draft" | "published"; number?: number };
  /** On a test run: the steps whose calls were simulated, by step id. Their results are not real. */
  simulatedSteps?: string[];
}

/** Why a call was refused or failed, as the interface told it. */
export interface AppCallFailure {
  /** `action_unknown`, `draft_safe_mode`, `forbidden`, `input_invalid` or a Connection's reason. */
  code: string;
  message: string;
  /** The right a `forbidden` call lacks. */
  right?: string;
  /** `false` where the same call again cannot come out differently. */
  retryable?: boolean;
  runId?: string;
}

export interface AppThemeChange {
  theme: AppTheme;
  mode: AppThemeMode;
}

/** What a Page sends. Every message after the first carries the session the host named. */
export type PageMessage =
  | { type: "ready" }
  | { type: "navigate"; session: string; path: string }
  | { type: "resize"; session: string; height: number }
  | {
      type: "action";
      session: string;
      requestId: string;
      name: string;
      input: Record<string, unknown>;
      idempotencyKey?: string;
    }
  | { type: "workflow_run"; session: string; requestId: string; runId: string };

/** What the interface sends. */
export type HostMessage =
  | { type: "context"; session: string; context: AppContext }
  | ({ type: "theme" } & AppThemeChange)
  | ({ type: "action_result"; session: string; requestId: string } & (
      { ok: true; result: AppCallResult } | { ok: false; error: AppCallFailure }
    ))
  | ({ type: "workflow_run_result"; session: string; requestId: string } & (
      { ok: true; run: AppWorkflowRun } | { ok: false; error: AppCallFailure }
    ));

const THEME_KEYS = [
  "surfaceColor",
  "backgroundColor",
  "textColor",
  "mutedTextColor",
  "borderColor",
  "accentColor",
  "accentStrongColor"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTheme(value: unknown): AppTheme | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const colors: Partial<Record<(typeof THEME_KEYS)[number], string>> = {};
  for (const key of THEME_KEYS) {
    const color = value[key];
    if (typeof color !== "string") {
      return undefined;
    }
    colors[key] = color;
  }
  const { surfaceColor, backgroundColor, textColor, mutedTextColor, borderColor } = colors;
  const { accentColor, accentStrongColor } = colors;
  return surfaceColor === undefined ||
    backgroundColor === undefined ||
    textColor === undefined ||
    mutedTextColor === undefined ||
    borderColor === undefined ||
    accentColor === undefined ||
    accentStrongColor === undefined
    ? undefined
    : {
        surfaceColor,
        backgroundColor,
        textColor,
        mutedTextColor,
        borderColor,
        accentColor,
        accentStrongColor
      };
}

function readMode(value: unknown): AppThemeMode | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

const PERMISSIONS: readonly string[] = ["allow", "confirm", "approval", "deny"];

function isPermission(value: unknown): value is AppActionPermission {
  return typeof value === "string" && PERMISSIONS.includes(value);
}

function readCan(value: unknown): Record<string, AppActionPermission> {
  const can: Record<string, AppActionPermission> = {};
  if (isRecord(value)) {
    for (const [name, permission] of Object.entries(value)) {
      if (isPermission(permission)) {
        Object.defineProperty(can, name, { value: permission, enumerable: true });
      }
    }
  }
  return can;
}

function readCallResult(value: unknown): AppCallResult | undefined {
  if (isRecord(value) && value.status === "dry_run" && typeof value.message === "string") {
    return { status: "dry_run", message: value.message, result: value.result };
  }
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    (value.status !== "done" && value.status !== "pending_approval")
  ) {
    return undefined;
  }
  return {
    runId: value.runId,
    status: value.status,
    ...("result" in value ? { result: value.result } : {})
  };
}

const RUN_STATUSES: readonly string[] = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
  "limit_reached"
];

function isRunStatus(value: unknown): value is AppWorkflowRunStatus {
  return typeof value === "string" && RUN_STATUSES.includes(value);
}

function readWorkflowRun(value: unknown): AppWorkflowRun | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.workflow !== "string" ||
    !isRunStatus(value.status)
  ) {
    return undefined;
  }
  const { error } = value;
  return {
    id: value.id,
    workflow: value.workflow,
    status: value.status,
    ...("output" in value ? { output: value.output } : {}),
    ...(value.outputTruncated === true ? { outputTruncated: true } : {}),
    ...(isRecord(error) && typeof error.code === "string" && typeof error.message === "string"
      ? { error: { code: error.code, message: error.message } }
      : {}),
    ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.finishedAt === "string" ? { finishedAt: value.finishedAt } : {}),
    ...(value.mode === "test" ? { mode: "test" as const } : {}),
    ...readRunRevision(value.workflowRevision),
    ...(Array.isArray(value.simulatedSteps)
      ? {
          simulatedSteps: value.simulatedSteps.filter(
            (step): step is string => typeof step === "string"
          )
        }
      : {})
  };
}

function readRunRevision(value: unknown): Pick<AppWorkflowRun, "workflowRevision"> {
  if (!isRecord(value) || (value.kind !== "draft" && value.kind !== "published")) {
    return {};
  }
  return {
    workflowRevision: {
      kind: value.kind,
      ...(typeof value.number === "number" ? { number: value.number } : {})
    }
  };
}

function readCallFailure(value: unknown): AppCallFailure | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    ...(typeof value.right === "string" ? { right: value.right } : {}),
    ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {})
  };
}

function readContext(value: unknown): AppContext | undefined {
  if (!isRecord(value) || !isRecord(value.viewer)) {
    return undefined;
  }
  const { viewer, workspace } = value;
  const theme = readTheme(value.theme);
  const mode = readMode(value.mode);
  if (
    viewer.kind !== "member" ||
    typeof viewer.id !== "string" ||
    typeof viewer.displayName !== "string" ||
    typeof value.locale !== "string" ||
    typeof value.pageId !== "string" ||
    typeof value.fileSetNumber !== "number" ||
    typeof value.initialRoute !== "string" ||
    !theme ||
    !mode
  ) {
    return undefined;
  }
  return {
    viewer: { kind: "member", id: viewer.id, displayName: viewer.displayName },
    workspace:
      isRecord(workspace) && typeof workspace.id === "string" && typeof workspace.name === "string"
        ? { id: workspace.id, name: workspace.name }
        : null,
    locale: value.locale,
    theme,
    mode,
    pageId: value.pageId,
    fileSetNumber: value.fileSetNumber,
    initialRoute: value.initialRoute,
    can: readCan(value.can)
  };
}

/** Reads what arrived as a message of the interface, or nothing when it is not one. */
export function readHostMessage(data: unknown): HostMessage | undefined {
  if (!isRecord(data) || data[BRIDGE_MARK] !== BRIDGE_VERSION) {
    return undefined;
  }
  if (data.type === "context" && typeof data.session === "string") {
    const context = readContext(data.context);
    return context ? { type: "context", session: data.session, context } : undefined;
  }
  if (data.type === "theme") {
    const theme = readTheme(data.theme);
    const mode = readMode(data.mode);
    return theme && mode ? { type: "theme", theme, mode } : undefined;
  }
  if (
    data.type === "action_result" &&
    typeof data.session === "string" &&
    typeof data.requestId === "string"
  ) {
    const { session, requestId } = data;
    if (data.ok === true) {
      const result = readCallResult(data.result);
      return result ? { type: "action_result", session, requestId, ok: true, result } : undefined;
    }
    const error = readCallFailure(data.error);
    return error ? { type: "action_result", session, requestId, ok: false, error } : undefined;
  }
  if (
    data.type === "workflow_run_result" &&
    typeof data.session === "string" &&
    typeof data.requestId === "string"
  ) {
    const { session, requestId } = data;
    if (data.ok === true) {
      const run = readWorkflowRun(data.run);
      return run ? { type: "workflow_run_result", session, requestId, ok: true, run } : undefined;
    }
    const error = readCallFailure(data.error);
    return error
      ? { type: "workflow_run_result", session, requestId, ok: false, error }
      : undefined;
  }
  return undefined;
}

/** A message as it is posted: with the mark of the bridge. */
export function envelope(message: PageMessage): Record<string, unknown> {
  return { [BRIDGE_MARK]: BRIDGE_VERSION, ...message };
}
