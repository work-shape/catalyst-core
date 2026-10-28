import { z } from "zod";
import { APP_EDIT_TOOL_NAME, type ToolExecutionContext } from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";

export { APP_EDIT_TOOL_NAME };
export interface AppEdited {
  name: string;
  title: string;
  path: string;
  revision: number;
  pageId: string;
  fileSetId: string;
  number: number;
}
export interface AppEditCalls {
  editApp(context: ToolExecutionContext, input: { name: string }): Promise<AppEdited>;
}

export function createAppEditTool(calls: AppEditCalls) {
  return defineTool({
    name: APP_EDIT_TOOL_NAME,
    title: { en: "Edit app", de: "App bearbeiten" },
    summary: {
      en: "Loads an App's current draft and all its files into this conversation.",
      de: "Lädt den aktuellen Entwurf einer App mit allen Dateien in diese Unterhaltung."
    },
    group: "results",
    icon: "app",
    effect: "changing",
    permission: { mode: "allow" },
    description:
      "On the person's request to change an existing App, load its current draft into this conversation. Needs app.write and a conversation of the person's own in the App's workspace. Replaces this App's working folder, including unsaved changes. Returns its path and opens its preview. Read and change files there, then workspace.open that path and app.save it. No lock is taken. If app.save refuses because the draft moved, tell the person who saved and when, call app.edit again, and redo your change on the loaded files before saving again. Never overwrite from the stale copy or ask for the original build chat.",
    inputSchema: z.object({
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u)
        .describe("The App id returned by platform.assets.list or platform.assets.get.")
    }),
    outputSchema: z.object({
      name: z.string(),
      title: z.string(),
      path: z.string(),
      revision: z.number().int(),
      pageId: z.string(),
      fileSetId: z.string(),
      number: z.number().int()
    }),
    async execute(input, context) {
      const edited = await calls.editApp(context, input);
      return toolSuccess(edited, {
        auditSummary: {
          action: APP_EDIT_TOOL_NAME,
          subject: edited.name,
          metadata: { revision: edited.revision }
        }
      });
    }
  });
}
