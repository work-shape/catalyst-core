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

const mark = { [APP_BRIDGE_MARK]: z.literal(APP_BRIDGE_VERSION) };
const session = z.string().min(1).max(200);

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

/** What `getContext()` of the kit answers. */
export const appBridgeContextSchema = z.strictObject({
  viewer: z.strictObject({ kind: z.literal("member"), id: z.string(), displayName: z.string() }),
  workspace: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  locale: z.string(),
  theme: appBridgeThemeSchema,
  mode: appBridgeModeSchema,
  pageId: z.string(),
  fileSetNumber: z.number().int().positive(),
  initialRoute: z.string()
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
  })
]);

export type AppBridgeHostMessage = z.infer<typeof appBridgeHostMessageSchema>;
