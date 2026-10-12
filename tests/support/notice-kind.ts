import { z } from "zod";
import type { WorkflowAssetKind } from "@vivd-catalyst/chat-server";
import { defineAssetKind } from "@vivd-catalyst/core";

export const noticeSchema = z.strictObject({ name: z.string(), text: z.string() });

/** A kind with a draft and a published revision and nothing else of an App: no files. */
export function createNoticeKind(): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: "notice",
      plural: "notices",
      schema: noticeSchema,
      nameRule: { pattern: /^[a-z][a-z0-9-]*$/u, maxLength: 40, description: "lowercase" },
      actions: {
        read: "app.read",
        write: "app.write",
        delete: "app.delete",
        publish: "app.publish"
      },
      lifecycle: "draft_published",
      validate: () => [],
      summarize: (notice) => ({ name: notice.name, title: notice.text })
    }),
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined
  };
}
