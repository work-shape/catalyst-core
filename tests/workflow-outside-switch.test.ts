import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  asApiCredentialId,
  asServicePrincipalId,
  createPlatformId,
  type AuthenticatedIdentity,
  type WorkflowManifest,
  type WorkflowTrigger
} from "@work-shape/catalyst-core";
import { workflowOutsideSwitchRefusal } from "@work-shape/catalyst-workflows";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { operationOf } from "./support/connection-operations";
import { issuePersonalKey, personalKeyToken } from "./support/personal-api-keys";
import type { WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows } from "./support/workflow-runs";

// Publishing a Workflow that reaches data closed to outside clients is a signed-in person's act
// too (WF-OUT): a Connection operation not exposed to outside clients or a Knowledge Base,
// through a child Workflow too, by the scan a start from outside asks. Otherwise a key fills a
// Data Store from such a Connection, with a Workflow of its own or by a child it re-publishes,
// for an outside Workflow to read.
//
// Starts by outside clients are a signed-in person's to turn on (WF-OUT). A key that may
// publish Workflows could otherwise publish a scheduled Workflow that copies what a Connection
// kept from outside clients into a Data Store, and an outside one that reads that store: the
// key would start the second and read data it may never read directly. A key's publish of a
// revision with the switch on is refused, also where a person turned it on before (the key's
// revision could read another store); a key turns it off as it publishes anything else.
// Real call path, real database.
//
// Each test fails without the change: the key's publish went live.

const SCOPES = [
  "workflow.read",
  "workflow.write",
  "workflow.publish",
  "workflow.use",
  "connection.use"
];

function withTriggers(kinds: string[]) {
  const manifest = notifyClients();
  const [trigger, ...rest] = manifest.steps;
  return {
    ...manifest,
    steps: [{ ...trigger, triggers: kinds.map((kind) => ({ kind })) }, ...rest]
  };
}

const OFF = withTriggers(["manual"]);
const ON = withTriggers(["manual", "outside"]);

const revisionSchema = z.object({ revision: z.number() });

describe("turning on starts by outside clients", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  const ready = async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { personalKeys: true, definitions: "assets" }
    );
    // crm answers outside clients, so nothing but the switch decides the publish.
    const exposure = ["workflow", "outside"];
    await t.seed("crm", {
      displayName: "Kundenregister",
      operations: [
        operationOf("echo", { exposure }),
        operationOf("write", { effect: "changing", exposure })
      ]
    });
    const key = personalKeyToken(t, (await issuePersonalKey(t, SCOPES, t.root.id)).secret);
    return { t, key: await key };
  };

  /** Writes the definition as a draft, by the key where given; answers the draft's revision. */
  async function write(
    t: WorkflowFixture,
    manifest: { id: string; name: string },
    headers?: Record<string, string>
  ) {
    const current = await t.call(t.root.id, "assets.get", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id }
    });
    const expectedRevision =
      current.statusCode === 200 ? revisionSchema.parse(current.json()).revision : null;
    const written = await t.call(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
      payload: { config: { name: manifest.id, manifest }, expectedRevision },
      ...(headers ? { headers } : {})
    });
    expect(written.statusCode, written.body).toBe(200);
    return revisionSchema.parse(written.json()).revision;
  }

  const publish = (t: WorkflowFixture, revision: number, headers?: Record<string, string>) =>
    t.call(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "notify-clients" },
      payload: { revision },
      ...(headers ? { headers } : {})
    });

  const published = async (t: WorkflowFixture) => {
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: "notify-clients"
    });
    return asset?.publishedRevision;
  };

  /** Stores crm with its operations exposed to Workflows, and to outside clients where asked. */
  const exposeCrm = (t: WorkflowFixture, outside: boolean) => {
    const exposure = outside ? ["workflow", "outside"] : ["workflow"];
    return t.seed("crm", {
      displayName: "Kundenregister",
      operations: [
        operationOf("echo", { exposure }),
        operationOf("write", { effect: "changing", exposure })
      ]
    });
  };

  const publishNamed = (
    t: WorkflowFixture,
    name: string,
    revision: number,
    headers?: Record<string, string>
  ) =>
    t.call(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name },
      payload: { revision },
      ...(headers ? { headers } : {})
    });

  const expectReachRefused = (
    response: { statusCode: number; body: string; json(): unknown },
    workflow: string
  ) => {
    expect(response.statusCode, response.body).toBe(403);
    expect(errorSchema.parse(response.json()).error.details).toEqual({
      reason: "reach_person_only",
      workflow
    });
    expect(response.body).toContain("the Connection 'crm'");
    expect(response.body).toContain("only a person signed in to Catalyst publishes it");
  };

  const expectRefused = (response: { statusCode: number; body: string; json(): unknown }) => {
    expect(response.statusCode, response.body).toBe(403);
    expect(errorSchema.parse(response.json()).error.details).toMatchObject({
      reason: "outside_switch_person_only",
      workflow: "notify-clients"
    });
    expect(response.body).toContain("only a person signed in to Catalyst publishes it");
  };

  it("refuses a key's publish of a Workflow that reads a Connection kept from outside clients, switch off", async () => {
    const { t, key } = await ready();
    await exposeCrm(t, false);
    // Scheduled or by hand, it could copy crm's answer into a store an outside Workflow reads.
    const revision = await write(t, OFF, key);
    expectReachRefused(await publish(t, revision, key), "notify-clients");
    expect(await published(t)).toBeUndefined();
    // The person publishes the same revision.
    const byPerson = await publish(t, revision);
    expect(byPerson.statusCode, byPerson.body).toBe(200);
    // Exposed to outside clients, the key publishes it as before.
    await exposeCrm(t, true);
    const open = await write(t, { ...OFF, name: "Notify clients again" }, key);
    const byKey = await publish(t, open, key);
    expect(byKey.statusCode, byKey.body).toBe(200);
    expect(await published(t)).toBe(open);
  });

  it("refuses a key's re-publish of a child that an outside Workflow starts, once the child reads closed data", async () => {
    const { t, key } = await ready();
    const child = { ...withTriggers(["parent"]), id: "read-clients", name: "Read clients" };
    const parent = {
      id: "outside-parent",
      name: "Outside parent",
      runAs: "workflow-runner",
      inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "outside" }] },
        {
          id: "child",
          name: "Read the clients",
          type: "workflow",
          workflow: "read-clients",
          input: { note: { ref: { step: "start", path: "input.note" } } }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    };
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    // A person publishes both while crm answers outside clients.
    const first = await publishNamed(t, "read-clients", await write(t, child));
    expect(first.statusCode, first.body).toBe(200);
    const outside = await publishNamed(t, "outside-parent", await write(t, parent));
    expect(outside.statusCode, outside.body).toBe(200);

    // crm's admin takes outside back. The key re-publishes the child the outside Workflow
    // starts: refused, since the child now reads data closed to outside clients.
    await exposeCrm(t, false);
    const again = await write(t, { ...child, name: "Read clients again" }, key);
    expectReachRefused(await publishNamed(t, "read-clients", again, key), "read-clients");
    // The person may publish it; the outside start stays refused at the start.
    const byPerson = await publishNamed(t, "read-clients", again);
    expect(byPerson.statusCode, byPerson.body).toBe(200);
    const started = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "outside-parent" },
      payload: { input: { note: NOTE } },
      headers: key
    });
    expect(started.statusCode, started.body).toBe(403);
  });

  it("refuses a key's first publish of a Workflow with the switch on", async () => {
    const { t, key } = await ready();
    const revision = await write(t, ON, key);
    expectRefused(await publish(t, revision, key));
    expect(await published(t)).toBeUndefined();
    // The person publishes the same revision.
    const byPerson = await publish(t, revision);
    expect(byPerson.statusCode, byPerson.body).toBe(200);
  });

  it("refuses a key's revision that turns the switch on", async () => {
    const { t, key } = await ready();
    const off = await write(t, OFF, key);
    expect((await publish(t, off, key)).statusCode).toBe(200);
    const on = await write(t, ON, key);
    expectRefused(await publish(t, on, key));
    expect(await published(t)).toBe(off);
    // The published revision stays closed to outside clients.
    const started = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: NOTE } },
      headers: key
    });
    expect(started.statusCode, started.body).toBe(409);
  });

  it("refuses a key's publish where a person turned the switch on, and lets it turn it off", async () => {
    const { t, key } = await ready();
    const on = await write(t, ON);
    expect((await publish(t, on)).statusCode).toBe(200);
    // Kept on, a key's revision could read a store the key's own Workflow fills.
    const again = await write(t, { ...ON, name: "Notify clients again" }, key);
    expectRefused(await publish(t, again, key));
    expect(await published(t)).toBe(on);
    // Turning it off is the key's to do.
    const off = await write(t, OFF, key);
    const closed = await publish(t, off, key);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(await published(t)).toBe(off);
  });

  it("lets a key's config push write the switch into a draft, and only a person publishes it", async () => {
    const { t, key } = await ready();
    const team = await t.sharedWorkspace("Team");
    const address = { kind: WORKFLOW_ASSET_KIND, name: "notify-clients" };
    // `catalyst config push` of a workspace: the batch writes drafts, nothing goes live.
    const push = (manifest: object, expectedRevision: number | null) =>
      t.call(t.root.id, "assets.sync", {
        payload: {
          workspaceId: team,
          items: [
            {
              type: "put",
              ...address,
              config: { name: "notify-clients", manifest },
              expectedRevision
            }
          ]
        },
        headers: key
      });
    const draftRevision = async () => {
      const draft = await t.call(t.root.id, "assets.get", {
        params: address,
        query: { workspaceId: team }
      });
      expect(draft.statusCode, draft.body).toBe(200);
      return revisionSchema.parse(draft.json()).revision;
    };
    // `--publish` is the key's publish.
    const publishIn = (revision: number, headers?: Record<string, string>) =>
      t.call(t.root.id, "assets.publish", {
        params: address,
        payload: { revision, workspaceId: team },
        ...(headers ? { headers } : {})
      });
    const pushed = await push(OFF, null);
    expect(pushed.statusCode, pushed.body).toBe(200);
    const off = await draftRevision();
    expect((await publishIn(off, key)).statusCode).toBe(200);

    const turned = await push(ON, off);
    expect(turned.statusCode, turned.body).toBe(200);
    const on = await draftRevision();
    expect(await published(t)).toBe(off);
    expectRefused(await publishIn(on, key));
    expect(await published(t)).toBe(off);
    // The person publishes the pushed draft.
    const byPerson = await publishIn(on);
    expect(byPerson.statusCode, byPerson.body).toBe(200);
  });

  it("gives the deployment's release key no Workflow to write, so it never turns the switch on", async () => {
    const { t } = await ready();
    const release = await t.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Release",
      permissions: ["config_assets.read", "config_assets.release"]
    });
    const issued = await t.call(t.root.id, "api_credentials.create", {
      params: { servicePrincipalId: release.id },
      payload: {
        name: "Release",
        scopes: ["config_assets:read", "config_assets:release"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const { secret } = z.object({ secret: z.string() }).parse(issued.json());
    const pushed = await t.call(release.id, "assets.sync", {
      payload: {
        items: [
          {
            type: "put",
            kind: WORKFLOW_ASSET_KIND,
            name: "notify-clients",
            config: { name: "notify-clients", manifest: ON },
            expectedRevision: null
          }
        ]
      },
      headers: await personalKeyToken(t, secret)
    });
    expect(pushed.statusCode, pushed.body).toBe(422);
    expect(pushed.body).toContain("is not part of a release");
    expect(await published(t)).toBeUndefined();
  });
});

describe("who turns on starts by outside clients", () => {
  const manifest = (triggers: WorkflowTrigger[]): Pick<WorkflowManifest, "id" | "steps"> => ({
    id: "notify-clients",
    steps: [{ id: "start", name: "Start", type: "trigger", triggers }]
  });
  const on = manifest([{ kind: "manual" }, { kind: "outside" }]);
  const off = manifest([{ kind: "manual" }]);
  const person: AuthenticatedIdentity = {
    id: "usr_tim",
    externalUserId: "tim",
    displayLabel: "Tim",
    roles: ["user"],
    permissionRefs: [],
    clientInstanceId,
    authSource: "test",
    authenticationMethod: "session-cookie"
  };

  it("is a person, in the app or through an agent in their chat, and no credential or run", () => {
    expect(workflowOutsideSwitchRefusal(on, person)).toBeUndefined();
    // A session token an embedding host issued for the person is the person.
    const { authenticationMethod: _session, ...embedded } = person;
    expect(
      workflowOutsideSwitchRefusal(on, {
        ...embedded,
        delegatedActor: { kind: "service_principal", id: "host", authSource: "test" }
      })
    ).toBeUndefined();
    const keyed: AuthenticatedIdentity[] = [
      {
        ...person,
        delegatedActor: {
          kind: "api_key",
          id: asApiCredentialId("key_1"),
          displayLabel: "Claude Code",
          authSource: "test"
        }
      },
      { ...embedded, keyScopes: ["workflow.publish"] }
    ];
    const service = {
      kind: "service" as const,
      id: asServicePrincipalId("svc_release"),
      displayLabel: "Release",
      permissionRefs: [],
      permissions: [],
      clientInstanceId,
      authSource: "test",
      scopes: []
    };
    for (const actor of [
      ...keyed,
      { ...service, credentialId: asApiCredentialId("cred_1") },
      { ...service, workflowRunId: createPlatformId<"WorkflowRunId">("wfr") }
    ]) {
      expect(workflowOutsideSwitchRefusal(on, actor)?.details).toMatchObject({
        reason: "outside_switch_person_only"
      });
      // The switch off is anyone's publish.
      expect(workflowOutsideSwitchRefusal(off, actor)).toBeUndefined();
    }
  });
});
