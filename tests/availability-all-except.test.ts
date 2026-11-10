import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentAvailabilitySchema } from "@work-shape/catalyst-api-contract";
import {
  AVAILABLE_EVERYWHERE,
  AVAILABLE_NOWHERE,
  asCollaborationWorkspaceId,
  asUserId,
  availabilityCovers,
  availabilityOfferedIn,
  availabilityOffersNowhere,
  availabilityUnion,
  isAgentAvailableInWorkspace,
  isRecord,
  ownerReachRefusal,
  type AgentAvailability,
  type AgentRuntime,
  type CollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import { runCli } from "@work-shape/catalyst-cli";
import {
  agent,
  clientInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { createTemporaryDirectory, jsonResponse } from "./support/config-cli";
import { testOperations } from "./support/operations";
import { createTestFetch } from "./support/test-instance";
import { setupAppInstance } from "./support/app-instance";
import { fixtureConnectionKind, seedConnection } from "./support/connections";

// An asset offered in every workspace except the Shared Workspaces it names: those made later
// offer it, the named ones do not. One reading of the three modes decides where it is offered.

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

const team = asCollaborationWorkspaceId("ws_team");
const other = asCollaborationWorkspaceId("ws_other");
const later = asCollaborationWorkspaceId("ws_later");
const personal = { kind: "personal" as const };
const shared = (id: CollaborationWorkspaceId) => ({ kind: "shared" as const, id });

const selected = (
  ids: CollaborationWorkspaceId[],
  personalWorkspaces = false
): AgentAvailability => ({
  mode: "selected",
  personalWorkspaces,
  collaborationWorkspaceIds: ids
});
const allExcept = (
  ids: CollaborationWorkspaceId[],
  personalWorkspaces = true
): AgentAvailability => ({
  mode: "all_except",
  personalWorkspaces,
  collaborationWorkspaceIds: ids
});

describe("where an availability offers an asset", () => {
  it("reads every mode alike for Personal and Shared Workspaces", () => {
    expect(isAgentAvailableInWorkspace(AVAILABLE_EVERYWHERE, personal)).toBe(true);
    expect(isAgentAvailableInWorkspace(AVAILABLE_EVERYWHERE, shared(later))).toBe(true);

    expect(isAgentAvailableInWorkspace(selected([team]), shared(team))).toBe(true);
    expect(isAgentAvailableInWorkspace(selected([team]), shared(later))).toBe(false);
    expect(isAgentAvailableInWorkspace(selected([team]), personal)).toBe(false);
    expect(isAgentAvailableInWorkspace(selected([], true), personal)).toBe(true);

    expect(isAgentAvailableInWorkspace(allExcept([team]), shared(team))).toBe(false);
    expect(isAgentAvailableInWorkspace(allExcept([team]), shared(other))).toBe(true);
    // A workspace made after the exclusion was never named, so it offers the asset.
    expect(isAgentAvailableInWorkspace(allExcept([team]), shared(later))).toBe(true);
    expect(isAgentAvailableInWorkspace(allExcept([team]), personal)).toBe(true);
    expect(isAgentAvailableInWorkspace(allExcept([team], false), personal)).toBe(false);

    expect(isAgentAvailableInWorkspace(undefined, shared(team))).toBe(false);
    expect(isAgentAvailableInWorkspace(allExcept([]), { kind: "shared" })).toBe(false);
  });

  it("is nowhere only where nothing is selected, never for all but some", () => {
    expect(availabilityOffersNowhere(undefined)).toBe(true);
    expect(availabilityOffersNowhere(AVAILABLE_NOWHERE)).toBe(true);
    expect(availabilityOffersNowhere(allExcept([team], false))).toBe(false);
    // So a Personal Workspace's asset is never offered as all but some.
    const mine = {
      kind: "workspace" as const,
      workspaceId: "ws_mine",
      workspaceKind: "personal" as const
    };
    expect(
      ownerReachRefusal(mine, { kind: "availability", availability: allExcept([team], false) })
    ).toBe("owner_reach");
    expect(
      ownerReachRefusal(mine, { kind: "availability", availability: AVAILABLE_NOWHERE })
    ).toBeUndefined();
  });

  it("covers and joins availabilities of every mode, later workspaces included", () => {
    expect(availabilityCovers(allExcept([team]), selected([other], true))).toBe(true);
    expect(availabilityCovers(allExcept([team]), selected([team]))).toBe(false);
    expect(availabilityCovers(allExcept([team]), allExcept([team, other]))).toBe(true);
    expect(availabilityCovers(allExcept([team, other]), allExcept([team]))).toBe(false);
    expect(availabilityCovers(selected([team, other], true), allExcept([team]))).toBe(false);
    expect(availabilityCovers(allExcept([], false), allExcept([], true))).toBe(false);
    expect(availabilityCovers(AVAILABLE_EVERYWHERE, allExcept([team]))).toBe(true);
    expect(availabilityCovers(allExcept([]), AVAILABLE_EVERYWHERE)).toBe(false);

    expect(availabilityUnion(allExcept([team, other]), selected([team]))).toEqual(
      allExcept([other])
    );
    expect(availabilityUnion(selected([team], true), allExcept([team, other], false))).toEqual(
      allExcept([other])
    );
    expect(availabilityUnion(allExcept([team, other]), allExcept([other, later]))).toEqual(
      allExcept([other])
    );
    expect(availabilityUnion(undefined, allExcept([team], false))).toEqual(
      allExcept([team], false)
    );
    expect(availabilityUnion(allExcept([team]), AVAILABLE_EVERYWHERE)).toEqual(
      AVAILABLE_EVERYWHERE
    );
    expect(availabilityOfferedIn(allExcept([team, other]), team)).toEqual(allExcept([other]));
    expect(availabilityOfferedIn(selected([other]), team)).toEqual(selected([other, team].sort()));
  });
});

const refuse = (): never => {
  throw new Error("Not used here");
};
/** Takes every run the start service prepared, without running it. */
const queuedRuntime: AgentRuntime = {
  async start(input) {
    const prepared = input.preparedRun ?? refuse();
    return { runId: prepared.id, status: "queued", startedAt: prepared.startedAt };
  },
  observe: () => refuse(),
  getStatus: async () => refuse(),
  resume: async () => refuse(),
  cancel: async () => refuse()
};

const agentsListed = z.object({
  defaultAgentName: z.string().optional(),
  items: z.array(z.object({ name: z.string() }))
});

describe("an agent offered in all workspaces except one", () => {
  it("is offered in every other workspace, also one made later, and refused in the excluded one", async () => {
    const t = await setupAccessInstance({
      storedAssetSource: true,
      server: () => ({ agentRuntime: queuedRuntime })
    });
    instances.push(t);
    const excluded = await t.sharedWorkspace("Excluded");
    const offered = await t.sharedWorkspace("Offered");
    for (const workspace of [excluded, offered]) {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace,
        userId: asUserId(t.kai.id),
        role: "member"
      });
    }
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "helper" },
      payload: { config: agent("helper"), availableIn: "all" }
    });
    const read = async () =>
      agentAvailabilitySchema.parse(
        (
          await t.expectOk(t.admin.id, "assets.get", { params: { kind: "agent", name: "helper" } })
        ).json<{ availability: unknown }>().availability
      );
    const before = await read();

    // The admin API takes the mode and answers it as stored; a read gives back the same.
    const set = await t.expectOk(t.admin.id, "assets.set_availability", {
      params: { kind: "agent", name: "helper" },
      payload: {
        mode: "all_except",
        personalWorkspaces: true,
        collaborationWorkspaceIds: [excluded],
        expectedAvailability: before
      }
    });
    const stored = {
      mode: "all_except",
      personalWorkspaces: true,
      collaborationWorkspaceIds: [excluded]
    };
    expect(set.json()).toEqual(stored);
    expect(await read()).toEqual(stored);
    // A mode the instance does not know is refused, never read as another.
    await t.expectRefused(
      t.admin.id,
      "assets.set_availability",
      {
        params: { kind: "agent", name: "helper" },
        payload: { mode: "everywhere_but", collaborationWorkspaceIds: [excluded] }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(await read()).toEqual(stored);

    const listedIn = async (workspaceId: CollaborationWorkspaceId) =>
      agentsListed
        .parse(
          (
            await t.expectOk(t.kai.id, "workspaces.agents.list", {
              params: { collaborationWorkspaceId: workspaceId }
            })
          ).json()
        )
        .items.map(({ name }) => name);
    expect(await listedIn(offered)).toContain("helper");
    expect(await listedIn(excluded)).not.toContain("helper");

    const newer = await t.sharedWorkspace("Newer");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: newer,
      userId: asUserId(t.kai.id),
      role: "member"
    });
    expect(await listedIn(newer)).toContain("helper");

    // A start naming the agent in the excluded workspace is refused; elsewhere it is taken.
    const conversationIn = async (workspaceId: CollaborationWorkspaceId) =>
      z.object({ id: z.string() }).parse(
        (
          await t.expectOk(t.kai.id, "conversations.create", {
            payload: { title: "Except", collaborationWorkspaceId: workspaceId }
          })
        ).json()
      ).id;
    const start = async (workspaceId: CollaborationWorkspaceId, key: string) =>
      t.call(t.kai.id, "conversations.runs.start", {
        params: { conversationId: await conversationIn(workspaceId) },
        payload: { agentName: "helper", idempotencyKey: key, message: { text: "Hello" } }
      });
    const refused = await start(excluded, "except-1");
    // As for an agent of no workspace there: the workspace does not know it.
    expect(refused.statusCode).toBe(404);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
    expect((await start(newer, "except-2")).statusCode).toBe(200);
  });

  it("is refused where it would leave a workspace without its own default, as selected is", async () => {
    const t = await setupAccessInstance({ storedAssetSource: true });
    instances.push(t);
    const own = await t.sharedWorkspace("Own");
    const plain = await t.sharedWorkspace("Plain");
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "assistant",
      availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    });
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "own-agent" },
      payload: { config: agent("own-agent"), availableIn: "all" }
    });
    await t.expectOk(t.admin.id, "assets.set_default", {
      params: { kind: "agent" },
      payload: { name: "own-agent", workspaceId: own }
    });
    const exclude = (name: string, ids: string[], personalWorkspaces = true) => ({
      params: { kind: "agent", name },
      payload: { mode: "all_except", personalWorkspaces, collaborationWorkspaceIds: ids }
    });

    // The workspace's own default is not taken away from it.
    const taken = await t.expectRefused(
      t.admin.id,
      "assets.set_availability",
      exclude("own-agent", [own]),
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "workspace_default_agent", collaborationWorkspaceIds: [own] }
      }
    );
    expect(taken.message).toContain("'Own'");
    await t.expectOk(t.admin.id, "assets.set_availability", exclude("own-agent", [plain]));

    // The instance default stays in every workspace that names none, and in Personal ones.
    const uncovered = await t.expectRefused(
      t.admin.id,
      "assets.set_availability",
      exclude("assistant", [plain]),
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "instance_default_agent", collaborationWorkspaceIds: [plain] }
      }
    );
    expect(uncovered.message).toContain("'Plain'");
    await t.expectRefused(
      t.admin.id,
      "assets.set_availability",
      exclude("assistant", [own], false),
      {
        status: 422,
        code: "VALIDATION_FAILED",
        details: { reason: "instance_default_agent" }
      }
    );
    await t.expectOk(t.admin.id, "assets.set_availability", exclude("assistant", [own]));

    // Once the workspace follows the instance default again it needs it: the exclusion goes
    // only with the default's own change, and a new workspace is offered it without one.
    const fresh = await t.sharedWorkspace("Fresh");
    const stored = (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get(
      "assistant"
    );
    expect(stored).toEqual({
      mode: "all_except",
      personalWorkspaces: true,
      collaborationWorkspaceIds: [own]
    });
    expect(isAgentAvailableInWorkspace(stored, shared(fresh))).toBe(true);
  });
});

describe("a Connection offered in all workspaces except one", () => {
  it("gives its use through a membership everywhere but there", async () => {
    const t = await setupAppInstance({
      modules: { connections: { enabled: true } },
      furtherKinds: [fixtureConnectionKind()]
    });
    instances.push(t);
    const alpha = await t.sharedWorkspace("Alpha");
    const beta = await t.sharedWorkspace("Beta");
    for (const workspace of [alpha, beta]) {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace,
        userId: asUserId(t.kai.id),
        role: "member"
      });
    }
    const crm = await seedConnection(t, "crm");
    await t.expectOk(t.admin.id, "assets.set_availability", {
      params: { kind: "connection", name: "crm" },
      payload: { mode: "all_except", collaborationWorkspaceIds: [beta] }
    });
    const narrowed = async (workspaceId: string) =>
      (
        await t.stores.access.loadPersistedAccess({
          clientInstanceId,
          holder: { kind: "user", id: t.kai.id },
          workspaceId
        })
      ).availableAssets?.map((asset) => asset.assetId);
    expect(await narrowed(alpha)).toContain(crm);
    expect(await narrowed(beta)).not.toContain(crm);
  });
});

describe("the CLI with an agent offered in all workspaces except one", () => {
  it("sets the mode, shows it and keeps it through a read and a change", async () => {
    const t = await setupAccessInstance({
      storedAssetSource: true,
      server: () => ({ authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" } })
    });
    instances.push(t);
    const excluded = await t.sharedWorkspace("Excluded");
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "helper" },
      payload: { config: agent("helper"), availableIn: "all" }
    });
    const serverFetch = createTestFetch(t.instance, { "x-test-user": t.admin.id });
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === testOperations["access_tokens.exchange"].path)
        return jsonResponse(200, {
          accessToken: "access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
      return serverFetch(request);
    };
    const cwd = await createTemporaryDirectory();
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli([...args, "--instance", "https://catalyst.test"], {
        cwd,
        env: { CATALYST_API_KEY: "cat_personal" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      });
      return { code, out: out.join(""), err: err.join("") };
    };

    const set = await run(
      "agent",
      "set-availability",
      "helper",
      "--mode",
      "all_except",
      "--personal",
      "--except",
      excluded
    );
    expect(set, set.err).toMatchObject({ code: 0 });
    expect(set.out).toContain(`is offered in every workspace except ${excluded}.`);
    expect((await run("agent", "show", "helper")).out).toContain(
      `available in: every workspace except ${excluded}`
    );
    // A second change compares against what the first one stored, all_except included.
    const again = await run("agent", "set-availability", "helper", "--mode", "all");
    expect(again, again.err).toMatchObject({ code: 0 });
    expect(
      (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get("helper")
    ).toEqual({ mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] });

    // A CLI that does not know a mode the instance answers stops at the read, before it
    // sends any change: it never writes another mode in its place.
    const unknown = (await run("agent", "show", "helper", "--json")).out;
    const future: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fetchImpl(request);
      if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/agent/helper"))
        return response;
      const body: unknown = await response.json();
      if (!isRecord(body) || !isRecord(body.availability)) return Response.json(body);
      return new Response(
        JSON.stringify({
          ...body,
          availability: { ...body.availability, mode: "some_later_mode" }
        }),
        { status: response.status, headers: response.headers }
      );
    };
    const sent: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      [
        "agent",
        "set-availability",
        "helper",
        "--mode",
        "selected",
        "--available-in",
        excluded,
        "--instance",
        "https://catalyst.test"
      ],
      {
        cwd,
        env: { CATALYST_API_KEY: "cat_personal" },
        fetchImpl: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          sent.push(`${request.method} ${new URL(request.url).pathname}`);
          return future(request);
        },
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      }
    );
    expect(unknown).toContain('"mode": "all"');
    expect(code).not.toBe(0);
    expect(err.join("")).toContain("does not match the API contract");
    expect(sent.some((line) => line.startsWith("PUT "))).toBe(false);
    expect(
      (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get("helper")?.mode
    ).toBe("all");

    const wrong = await run(
      "agent",
      "set-availability",
      "helper",
      "--mode",
      "selected",
      "--except",
      excluded
    );
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toContain("--except goes with --mode all_except.");
  });
});
