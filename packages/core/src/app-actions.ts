// What a named action of an App is called as an operation. The action itself, its input and
// what it reaches are compiled by the build (`@work-shape/catalyst-app-build`).

/**
 * The prefix of every operation that is a named action of an App: `app.<id>.<action>`. It is
 * singular. Operations that manage Apps use the plural `apps.`.
 */
export const APP_ACTION_OPERATION_PREFIX = "app.";

/**
 * The prefix of the operation a named action of a Page of a conversation runs as:
 * `page_action.<page id>.<action>`. A Page is no App and no published thing, so its runs
 * never carry the name of an App's action, whatever id its manifest names. The name is only
 * ever a run's: no registry resolves it, no agent carries it and no setting is read by it
 * unless an administrator writes one for it. It does not start with `page.`, which names
 * the operations that manage Pages.
 */
export const PAGE_ACTION_OPERATION_PREFIX = "page_action.";

/** The id of an App, as its manifest names it. */
export const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
/** The longest App id. */
const APP_ID_MAX_CHARS = 63;

/**
 * The id of an App, from the name people read for it: lowercase letters, digits and '-', at
 * most 63 characters. German letters keep their sound; a name of no such letter is "app".
 * Saving asks for the name alone, so the agent's `app.save` and a person's Save as app both
 * take the id from here.
 */
export function appIdFromName(name: string): string {
  const id = name
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, APP_ID_MAX_CHARS)
    .replace(/-+$/u, "");
  return id === "" ? "app" : id;
}
/** The name of a named action: lowercase letters, digits, '-' and '_', at most 63. */
export const APP_ACTION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/** The operation name of one named action of one App. */
export function appActionOperationName(app: string, action: string): string {
  return `${APP_ACTION_OPERATION_PREFIX}${app}.${action}`;
}

/** The operation name a named action of one Page runs as, by the id of the Page. */
export function pageActionOperationName(pageId: string, action: string): string {
  return `${PAGE_ACTION_OPERATION_PREFIX}${pageId}.${action}`;
}

/**
 * The App and the action a name stands for, or nothing where the name is not one of a named
 * action. Neither part holds a dot, so the name splits in one way only.
 */
export function parseAppActionOperationName(
  name: string
): { app: string; action: string } | undefined {
  if (!name.startsWith(APP_ACTION_OPERATION_PREFIX)) return undefined;
  const rest = name.slice(APP_ACTION_OPERATION_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) return undefined;
  const app = rest.slice(0, dot);
  const action = rest.slice(dot + 1);
  return APP_ID_PATTERN.test(app) && APP_ACTION_NAME_PATTERN.test(action)
    ? { app, action }
    : undefined;
}

/**
 * How large the input of one call of a frame may be, as the JSON it is sent as, in bytes. A
 * larger one is refused before anything is read of it.
 */
export const APP_ACTION_INPUT_MAX_BYTES = 256 * 1024;

/**
 * How many calls one page session may make in a minute, actions and reads of Workflow Runs together.
 * A page session is one mount of one frame for one viewer, so the limit bounds what one open
 * tile can ask of a Connection whatever its code does.
 */
export const APP_ACTION_CALLS_PER_MINUTE_PER_SESSION = 600;

/**
 * Why a call of a frame was refused before or beside what the Connection says, as
 * `details.reason` of the error and as the `code` the frame reads.
 */
export const APP_ACTION_REFUSALS = [
  "action_unknown",
  "draft_safe_mode",
  "forbidden",
  "input_invalid",
  "session_invalid",
  "rate_limited",
  "app_revision_changed",
  "app_gone"
] as const;

export type AppActionRefusal = (typeof APP_ACTION_REFUSALS)[number];
