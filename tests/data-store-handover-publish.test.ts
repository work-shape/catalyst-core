import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asUserId,
  type CollaborationWorkspaceId,
  type JsonObject
} from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";

// DS-13c on an assembled instance (check 68): the widening check runs on the server, inside
// the publish. A Workflow that hands a source's data to people who may not use it is refused
// until a holder of `connection.write` on the source confirms the hand-over with the token the
// publish question gives. The question counts the people and never names them.

const refusalSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z.object({ reason: z.string() }).loose()
  })
});

describe("the widening check inside a publish", () => {
  const { start, publishStore, person } = useDataStoreInstance();

  it("asks the question on the server and refuses an unconfirmed hand-over of a source's data", async () => {
    const world = await start(true, undefined, undefined, undefined, false, true);
    await publishStore(world);
    const { stores } = world;
    const members = await Promise.all(
      ["member-a", "member-b", "member-c"].map((name) => person(world, name, ["user"]))
    );
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: asUserId(required(members[0]).id)
    });
    for (const member of members.slice(1)) {
      await stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: asUserId(member.id),
        role: "member"
      });
    }

    /** Writes an asset's first revision, and makes it live where `live`. */
    async function write(
      kind: string,
      name: string,
      config: JsonObject,
      live?: { workspaceId: CollaborationWorkspaceId }
    ) {
      const key = `${kind}:${name}`;
      const saved = await stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [key]: null },
        mutations: [
          {
            type: "upsert",
            kind,
            name,
            config,
            draft: true,
            ...(live ? { scope: { kind: "workspace", workspaceId: live.workspaceId } } : {})
          }
        ]
      });
      const revision = required(saved.revisions[key]);
      if (live) {
        const stored = required(
          await stores.configAssets.getConfigAssetRevision({
            clientInstanceId,
            kind,
            name,
            revision
          })
        );
        await stores.configAssets.publishConfigAssetRevision({
          clientInstanceId,
          kind,
          name,
          assetId: required(saved.assetIds[key]),
          revision,
          revisionId: stored.id,
          audience: "workspace"
        });
      }
      return revision;
    }

    await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "connection:exampledata": null },
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "exampledata",
          config: { displayName: "Exampledata" }
        }
      ]
    });
    // The team reads the store's rows through its App.
    await write(
      "app",
      "overview",
      {
        title: "Overview",
        manifest: {
          actions: [
            {
              name: "list",
              kind: "sql",
              dataStore: "findings",
              effect: "reading",
              statement: "select * from findings"
            }
          ]
        }
      },
      { workspaceId: workspace.id }
    );
    // A Workflow would add rows to the store from a Connection the team may not use.
    const revision = await write("workflow", "import", {
      name: "import",
      manifest: {
        id: "import",
        name: "Import",
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          {
            id: "read",
            name: "Read",
            type: "operation",
            operation: "connection.exampledata.list",
            input: {}
          },
          {
            id: "store",
            name: "Store",
            type: "operation",
            operation: "data_store.findings.insert",
            input: {}
          },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      }
    });

    // The question names how many of the team may not use the source, and the confirmation.
    const read = await world.api.call("assets.get", {
      params: { kind: "workflow", name: "import" },
      query: { revision: String(revision) }
    });
    expect(read.statusCode, read.body).toBe(200);
    const question = z
      .object({
        publishHandover: z.object({
          holds: z.boolean(),
          lines: z.array(z.string()),
          confirmation: z.string()
        })
      })
      .parse(read.json()).publishHandover;
    // In the instance's language, here its English.
    expect(question).toMatchObject({
      holds: false,
      lines: [
        "3 people who read “Findings” after this publish may not use “Exampledata”. Publishing confirms the hand-over."
      ]
    });
    for (const member of members) {
      expect(read.body).not.toContain(member.id);
      expect(read.body).not.toContain(member.displayLabel);
    }

    // The publish without it is refused on the server, whatever an interface showed.
    const publish = (confirmHandover?: string) =>
      world.api.call("assets.publish", {
        params: { kind: "workflow", name: "import" },
        payload: { revision, ...(confirmHandover ? { confirmHandover } : {}) }
      });
    const unconfirmed = await publish();
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(409);
    expect(refusalSchema.parse(unconfirmed.json()).error).toMatchObject({
      code: "CONFLICT",
      details: {
        reason: "data_handover_unconfirmed",
        dataStore: "findings",
        readers: 3,
        connection: "exampledata",
        confirmation: question.confirmation
      }
    });
    const other = await publish("0".repeat(64));
    expect(refusalSchema.parse(other.json()).error.details.reason).toBe(
      "data_handover_unconfirmed"
    );
    const live = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "workflow",
      name: "import"
    });
    expect(live?.publishedRevisionId).toBeFalsy();

    // Confirmed, the Workflow goes live and the hand-over is audited by how many, never whom.
    const confirmed = await publish(question.confirmation);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const handedOver = (await stores.audit.listAuditEvents({ clientInstanceId })).filter(
      (event) => event.type === "data_store.handover_confirmed"
    );
    expect(handedOver).toHaveLength(1);
    const audited = JSON.stringify(handedOver);
    expect(audited).toContain('"people":3');
    for (const member of members) expect(audited).not.toContain(member.id);

    // Published again, the Workflow hands nothing on anew: the question holds in one line.
    const again = await world.api.call("assets.get", {
      params: { kind: "workflow", name: "import" },
      query: { revision: String(revision) }
    });
    expect(again.json()).toMatchObject({
      publishHandover: {
        holds: true,
        lines: ["This publish hands data from “Exampledata” to nobody new who may not use it."]
      }
    });
  });
});
