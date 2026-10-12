import { z } from "zod";
import { appActionPermissionSchema } from "./app-bridge";
import { pagePreviewSchema } from "./pages";

/** The kind id of an App in the asset registry. */
export const APP_ASSET_KIND = "app";

/** Which revision of an App is shown: the one its users are served, or the one being edited. */
export const appModeSchema = z.enum(["published", "draft"]);

export type AppMode = z.infer<typeof appModeSchema>;

/**
 * The path of the interface route that shows one App to a signed-in person: the published
 * revision, or with `/edit` the draft. The server answers it from `apps.preview` and the
 * interface builds its routes from it, so the two never disagree.
 */
export function appInterfacePath(input: {
  workspaceId: string;
  app: string;
  mode: AppMode;
}): string {
  const path = `/w/${encodeURIComponent(input.workspaceId)}/apps/${encodeURIComponent(input.app)}`;
  return input.mode === "draft" ? `${path}/edit` : path;
}

export const createAppFromPageRequestSchema = z
  .object({
    conversationId: z.string().min(1),
    pageId: z.string().min(1),
    /** The id of the App: lowercase letters, digits and '-'. It is unique on the instance. */
    name: z.string().min(1).max(63),
    /** What people read as the App's name. */
    title: z.string().min(1).max(120),
    /** The workspace the App belongs to. */
    workspaceId: z.string().min(1)
  })
  .strict();

export const createAppFromPageResponseSchema = z.object({
  /** The id of the asset. */
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  /** The draft revision the call made. Nothing is published. */
  revision: z.number().int().positive(),
  fileSetId: z.string()
});

export const appPreviewRequestSchema = z.object({ mode: appModeSchema }).strict();

/**
 * Where a frame loads one revision of an App, in the shape of `pages.preview`, and where a
 * signed-in person opens the same revision in the interface. `url` is a credential of its
 * caller: put it in the frame and nowhere else. `interfacePath` holds none and can be shared.
 */
export const appPreviewSchema = pagePreviewSchema.extend({
  /** The number of the asset revision shown. */
  revision: z.number().int().positive(),
  interfacePath: z.string()
});

export type AppPreviewResponse = z.infer<typeof appPreviewSchema>;

/**
 * What names the frame a call comes from: the file set it shows and the token of its address,
 * as `pages.preview` or `apps.preview` answered them to this caller. The server checks that
 * the token was minted for this caller, this file set and the page session of the path.
 */
const pageSessionProof = {
  fileSetId: z.string().min(1).max(200),
  token: z.string().min(1).max(512)
};

export const appSessionContextRequestSchema = z.object(pageSessionProof).strict();

/** What each action of the shown manifest would come to for the caller now. */
export const appSessionContextSchema = z.object({
  can: z.record(z.string(), appActionPermissionSchema)
});

export const appActionCallRequestSchema = z
  .object({
    ...pageSessionProof,
    /** The parameters of the action, by name. */
    input: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const appConnectionCallRequestSchema = z
  .object({
    ...pageSessionProof,
    /** The input of the Connection's operation, as its accepted schema describes it. */
    input: z.unknown().optional()
  })
  .strict();

/**
 * How a call of a frame went. `done` carries what the operation answered. `pending_approval`
 * carries nothing: the call waits for another person and its run says how it ends.
 */
export const appActionCallResultSchema = z.object({
  runId: z.string(),
  status: z.enum(["done", "pending_approval"]),
  result: z.unknown().optional()
});

export type AppSessionContextResponse = z.infer<typeof appSessionContextSchema>;
export type AppActionCallResult = z.infer<typeof appActionCallResultSchema>;
