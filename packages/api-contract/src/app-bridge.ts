import { IDEMPOTENCY_KEY_MAX_LENGTH } from "@vivd-catalyst/core";
import { z } from "zod";

// The bridge between a Page and the interface that shows it, as the interface reads it. A Page
// is code an agent wrote: what it posts is validated against these schemas before anything is
// done with it, and what does not fit is dropped. The kit's side of the same messages is
// `packages/app-kit/src/protocol.ts`, written without a schema library.

/** The key that marks a message of the bridge. Its value is the version of the shapes below. */
export const APP_BRIDGE_MARK = "catalystBridge";
export const APP_BRIDGE_VERSION = 1;
/** The longest route a Page may report. */
export const APP_BRIDGE_MAX_PATH_CHARS = 2048;
/** The highest content height a Page may report, in pixels. */
export const APP_BRIDGE_MAX_HEIGHT_PX = 100_000;

/** The longest id a Page may give one of its calls. The answer carries it back. */
export const APP_BRIDGE_REQUEST_ID_MAX_CHARS = 100;
/** The longest name of an action, a Connection or an operation a Page may send. */
export const APP_BRIDGE_NAME_MAX_CHARS = 200;

const mark = { [APP_BRIDGE_MARK]: z.literal(APP_BRIDGE_VERSION) };
const session = z.string().min(1).max(200);
const requestId = z.string().min(1).max(APP_BRIDGE_REQUEST_ID_MAX_CHARS);
const calledName = z.string().min(1).max(APP_BRIDGE_NAME_MAX_CHARS);
const idempotencyKey = z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).optional();

/** What a Page posts. Unknown keys are refused, so a message is exactly one of these. */
export const appBridgePageMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...mark, type: z.literal("ready") }),
  z.strictObject({
    ...mark,
    type: z.literal("navigate"),
    session,
    // A route of the Page: it starts with one slash and names no host.
    path: z
      .string()
      .min(1)
      .max(APP_BRIDGE_MAX_PATH_CHARS)
      .regex(/^\/(?!\/)/u)
  }),
  z.strictObject({
    ...mark,
    type: z.literal("resize"),
    session,
    height: z.number().finite().min(0).max(APP_BRIDGE_MAX_HEIGHT_PX)
  }),
  // A call of a named action of the manifest. The interface makes it with the viewer's own
  // session. The frame holds no credential and reaches nothing but the interface.
  z.strictObject({
    ...mark,
    type: z.literal("action"),
    session,
    requestId,
    name: calledName,
    input: z.record(z.string(), z.unknown()),
    idempotencyKey
  }),
  // A call of one operation of a Connection the manifest lists.
  z.strictObject({
    ...mark,
    type: z.literal("connection_call"),
    session,
    requestId,
    connection: calledName,
    operation: calledName,
    input: z.unknown(),
    idempotencyKey
  })
]);

export type AppBridgePageMessage = z.infer<typeof appBridgePageMessageSchema>;

/** The seven colours of a theme, as an instance sets them per mode. */
export const appBridgeThemeSchema = z.strictObject({
  surfaceColor: z.string(),
  backgroundColor: z.string(),
  textColor: z.string(),
  mutedTextColor: z.string(),
  borderColor: z.string(),
  accentColor: z.string(),
  accentStrongColor: z.string()
});

export const appBridgeModeSchema = z.enum(["light", "dark"]);

/**
 * What the viewer's call of one action would come to now, as the server computed it: it runs,
 * it runs as the viewer's own confirmation, it waits for another person's approval, or it is
 * refused. A hint for what a Page shows. The call itself is checked again when it is made.
 */
export const appActionPermissionSchema = z.enum(["allow", "confirm", "approval", "deny"]);

export type AppActionPermission = z.infer<typeof appActionPermissionSchema>;

/** What `getContext()` of the kit answers. */
export const appBridgeContextSchema = z.strictObject({
  viewer: z.strictObject({ kind: z.literal("member"), id: z.string(), displayName: z.string() }),
  workspace: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  locale: z.string(),
  theme: appBridgeThemeSchema,
  mode: appBridgeModeSchema,
  pageId: z.string(),
  fileSetNumber: z.number().int().positive(),
  initialRoute: z.string(),
  /** Per action of the manifest. Absent where the interface could not read it. */
  can: z.record(z.string(), appActionPermissionSchema).optional()
});

export type AppBridgeContext = z.infer<typeof appBridgeContextSchema>;

/** What the interface posts into the frame of a Page. */
export const appBridgeHostMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...mark, type: z.literal("context"), session, context: appBridgeContextSchema }),
  z.strictObject({
    ...mark,
    type: z.literal("theme"),
    theme: appBridgeThemeSchema,
    mode: appBridgeModeSchema
  }),
  // The answer to one `action` or `connection_call`, named by the id the Page gave it.
  z.strictObject({
    ...mark,
    type: z.literal("action_result"),
    session,
    requestId,
    ok: z.boolean(),
    result: z
      .strictObject({
        runId: z.string(),
        status: z.enum(["done", "pending_approval"]),
        result: z.unknown().optional()
      })
      .optional(),
    error: z
      .strictObject({
        /** `action_unknown`, `draft_safe_mode`, `forbidden`, `input_invalid` and so on. */
        code: z.string(),
        message: z.string(),
        /** The right a `forbidden` call lacks. */
        right: z.string().optional(),
        /**
         * `false` where making the same call again cannot come out differently, such as a
         * missing right. A page then offers no button to try again.
         */
        retryable: z.boolean().optional(),
        runId: z.string().optional()
      })
      .optional()
  })
]);

export type AppBridgeHostMessage = z.infer<typeof appBridgeHostMessageSchema>;
