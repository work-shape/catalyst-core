import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { platformContextSchema, roleSchema } from "@work-shape/catalyst-api-contract";
import { setupAccessInstance, type AccessInstance } from "./support/access-instance";

// RIGHTS-1f: `service_principals.manage`, held by `admin` by default, is given to a person on
// the whole instance on the Access page, under the rule of no escalation, and gives way to a
// deny. Who holds it administers service principals; who does not is refused.

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

async function setup(): Promise<AccessInstance> {
  const t = await setupAccessInstance();
  instances.push(t);
  return t;
}

const MANAGE = "service_principals.manage";

const give = (holderId: string, effect: "allow" | "deny" = "allow") => ({
  payload: { holderKind: "user", holderId, action: MANAGE, effect, scopeKind: "instance" }
});

const principalSchema = z.object({ principal: z.object({ id: z.string() }) });

async function instanceActions(t: AccessInstance, userId: string): Promise<string[]> {
  return platformContextSchema.parse((await t.expectOk(userId, "platform.context.get")).json())
    .instanceActions;
}

async function createsPrincipal(t: AccessInstance, userId: string, name: string) {
  return t.call(userId, "service_principals.create", {
    payload: { name, displayLabel: name }
  });
}

describe("service_principals.manage given to a person (RIGHTS-1f)", () => {
  it("lets a person granted it administer service principals, and the platform context says so", async () => {
    const t = await setup();
    // Kai holds User alone: no list, no create, and the interface shows no API access.
    expect(await instanceActions(t, t.kai.id)).not.toContain(MANAGE);
    await t.expectRefused(t.kai.id, "service_principals.list", {}, t.forbidden(MANAGE, "no_grant"));
    expect((await createsPrincipal(t, t.kai.id, "kai-runner")).statusCode).toBe(403);

    // An admin holds it by their role and gives it on.
    await t.expectOk(t.admin.id, "permissions.grant", give(t.kai.id));

    expect(await instanceActions(t, t.kai.id)).toContain(MANAGE);
    await t.expectOk(t.kai.id, "service_principals.list");
    const made = await createsPrincipal(t, t.kai.id, "kai-runner");
    expect(made.statusCode, made.body).toBe(200);
    const principal = principalSchema.parse(made.json()).principal.id;
    await t.expectOk(t.kai.id, "service_principals.update", {
      params: { servicePrincipalId: principal },
      payload: { status: "disabled" }
    });
  });

  it("is given only by who holds it, never to oneself", async () => {
    const t = await setup();
    // Giving a person anything needs "Manage users" first.
    await t.expectRefused(
      t.kai.id,
      "permissions.grant",
      give(t.lena.id),
      t.forbidden("users.manage", "no_grant")
    );
    // A person who manages users and does not hold the right gives it to nobody.
    await t.expectOk(t.root.id, "users.update", {
      params: { userId: t.lena.id },
      payload: { permissions: ["users.manage"] }
    });
    await t.expectRefused(
      t.lena.id,
      "permissions.grant",
      give(t.kai.id),
      t.forbidden(MANAGE, "no_grant")
    );
    expect(await instanceActions(t, t.kai.id)).not.toContain(MANAGE);

    const own = await t.call(t.admin.id, "permissions.grant", give(t.admin.id));
    expect(own.statusCode).toBe(403);
    expect(own.json()).toMatchObject({
      error: { details: { reason: "holder_not_administrable" } }
    });

    // Who was given it gives it on, beside "Manage users", as any holder does.
    await t.expectOk(t.admin.id, "permissions.grant", give(t.lena.id));
    await t.expectOk(t.lena.id, "permissions.grant", give(t.kai.id));
    expect(await instanceActions(t, t.kai.id)).toContain(MANAGE);
  });

  it("is held on the whole instance only", async () => {
    const t = await setup();
    const workspaceId = await t.sharedWorkspace("Operators");
    const refused = await t.call(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: MANAGE,
        scopeKind: "workspace",
        scopeId: workspaceId
      }
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "invalid_scope" } } });
    expect(await instanceActions(t, t.kai.id)).not.toContain(MANAGE);
  });

  it("gives way to a deny: on the person over a role, and on a role over the person", async () => {
    const t = await setup();
    // A deny on the admin takes away what their role gives.
    await t.expectOk(t.root.id, "permissions.grant", give(t.admin.id, "deny"));
    await t.expectRefused(t.admin.id, "service_principals.list", {}, t.forbidden(MANAGE, "denied"));
    expect((await createsPrincipal(t, t.admin.id, "denied-runner")).statusCode).toBe(403);
    expect(await instanceActions(t, t.admin.id)).not.toContain(MANAGE);
    // Denied, they give it on no more.
    expect((await t.call(t.admin.id, "permissions.grant", give(t.kai.id))).statusCode).toBe(403);

    // A role's deny takes away what a grant gives the person.
    await t.expectOk(t.root.id, "permissions.grant", give(t.kai.id));
    await t.expectOk(t.kai.id, "service_principals.list");
    const refusing = roleSchema.parse(
      (
        await t.expectOk(t.root.id, "roles.create", {
          payload: {
            name: "No service principals",
            grants: [{ action: MANAGE, effect: "deny", scopeKind: "instance" }]
          }
        })
      ).json()
    );
    await t.expectOk(t.root.id, "users.update", {
      params: { userId: t.kai.id },
      payload: { roles: ["user", refusing.id] }
    });
    await t.expectRefused(t.kai.id, "service_principals.list", {}, t.forbidden(MANAGE, "denied"));
    expect(await instanceActions(t, t.kai.id)).not.toContain(MANAGE);
  });
});
