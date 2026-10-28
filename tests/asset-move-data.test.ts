import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asUserId } from "@work-shape/catalyst-core";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { auth, seed, store } from "./support/reference-owners";

// SHARE-1: the check of a move says when the rows of a Data Store go with it, and who reads
// them afterwards, before anything moves.

const checkSchema = z.looseObject({
  moves: z.array(z.looseObject({ kind: z.string(), name: z.string() })),
  data: z.array(z.looseObject({ kind: z.string(), name: z.string(), sentence: z.string() }))
});

describe("the check of a move that takes a Data Store along", () => {
  const { start } = useDataStoreInstance();

  it("says the rows go along and the team reads them afterwards", async () => {
    const world = await start(true, undefined, auth, undefined, true, true);
    const caller = asUserId((await world.api.call("me.get", {})).json<{ id: string }>().id);
    const team = await world.stores.workspaces.createWorkspace({
      clientInstanceId,
      name: "Vertrieb",
      kind: "shared",
      creatorUserId: caller
    });
    const membership = { clientInstanceId, collaborationWorkspaceId: team.id, userId: caller };
    if (!(await world.stores.workspaces.getMembership(membership)))
      await world.stores.workspaces.addMembership({ ...membership, role: "member" });
    const personal = await world.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: caller
    });
    await seed(world, "data_store", store("orders"), {
      kind: "workspace",
      workspaceId: personal.id
    });
    for (const [locale, sentence] of [
      ["de", "Die Daten in „orders“ gehen mit und sind dann für das Team „Vertrieb“ lesbar."],
      ["en", 'The data in "orders" goes along and can then be read by the team "Vertrieb".']
    ] as const) {
      const response = await world.api.call("assets.move_check", {
        params: { kind: "data_store", name: "orders" },
        payload: { workspaceId: personal.id, to: { kind: "workspace", workspaceId: team.id } },
        headers: { "accept-language": locale }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(checkSchema.parse(response.json()).data).toEqual([
        expect.objectContaining({ kind: "data_store", name: "orders", sentence })
      ]);
    }
  });
});
