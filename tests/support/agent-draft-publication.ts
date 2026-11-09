import { z } from "zod";
import type { AccessInstance } from "./access-instance";

/**
 * Test setup that needs a live revision publishes as the fixture's administrator explicitly,
 * in the workspace that owns the agent where it names one.
 */
export async function publishAgentDraft(
  t: Pick<AccessInstance, "admin" | "expectOk">,
  name: string,
  workspaceId?: string
) {
  const inWorkspace = workspaceId ? { workspaceId } : {};
  const { draft } = z.object({ draft: z.object({ revision: z.number() }).nullable() }).parse(
    (
      await t.expectOk(t.admin.id, "agents.draft.get", {
        params: { name },
        query: inWorkspace
      })
    ).json()
  );
  if (draft)
    await t.expectOk(t.admin.id, "assets.publish", {
      params: { kind: "agent", name },
      payload: { revision: draft.revision, ...inWorkspace }
    });
}
