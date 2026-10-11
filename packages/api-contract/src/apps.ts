import { z } from "zod";
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
