import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRANTABLE_ACTION_SCOPES,
  ROLE_DEFAULT_ACTIONS,
  SUPERADMIN_GRANTED_ACTIONS,
  isGrantableAction,
  isPlatformAction,
  isPermission
} from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";

// Access acceptance check 40 (RIGHTS-1e): no hard-wired gates. Every gate of the sweep under
// "No hard-wired gates" in `access-and-permissions.md` is a grantable right with a role default
// or is on the named list there, and every check of the superadmin role in `packages/*/src`
// is one of the named list's. A new check of the role fails here until it is a right, or until
// the spec names it and this list says where.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What a check of the superadmin role looks like in the code. */
const SUPERADMIN_CHECK = /isSuperadmin\(|\.includes\("superadmin"\)|[!=]== "superadmin"/gu;

/** The items of the named list in the spec, each a reason a check of the role may stay. */
const NAMED = {
  role: "Assigning or removing `superadmin`, and what a role holds by being it",
  account: "Changing a superadmin's account",
  seeing: "Seeing superadmin holders in user and grant lists",
  last: "The last-superadmin guard",
  handsOut:
    "Giving `api_access.manage` or `agent_models.manage`, or a principal `config_assets.release` (D8)",
  floor:
    "A deny through a role or a group never reaches a superadmin (ADR-0028, amended 2026-10-21)",
  owner: "A superadmin as Owner of every shared workspace, deleting another owner's one (D6)",
  definition: "The definition of the check itself",
  notAGate: "Not a gate: no right is asked"
} as const;

type Reason = (typeof NAMED)[keyof typeof NAMED];

/** Each file with a check of the role, how many it has, and why each may stay. */
const ALLOWED: Record<string, { count: number; reason: Reason }> = {
  // The definition, the floor (`holder.roles.includes`) and the role's computed default.
  "packages/core/src/permissions.ts": { count: 5, reason: NAMED.definition },
  "packages/server/src/access/access-service.ts": { count: 5, reason: NAMED.seeing },
  "packages/server/src/access/grant-holder-rules.ts": { count: 2, reason: NAMED.account },
  "packages/server/src/access/principal-rights.ts": { count: 1, reason: NAMED.handsOut },
  "packages/server/src/access/role-rights.ts": { count: 1, reason: NAMED.role },
  "packages/server/src/access/role-service.ts": { count: 3, reason: NAMED.role },
  "packages/server/src/access/user-administration-rights.ts": { count: 3, reason: NAMED.account },
  "packages/server/src/users/last-superadmin.ts": { count: 2, reason: NAMED.last },
  "packages/server/src/users/user-administration-service.ts": { count: 3, reason: NAMED.seeing },
  "packages/server/src/routes/access-routes.ts": { count: 1, reason: NAMED.seeing },
  "packages/server/src/connections/connection-access.ts": { count: 1, reason: NAMED.seeing },
  "packages/server/src/platform/workflow-authoring-context.ts": { count: 1, reason: NAMED.seeing },
  "packages/server/src/workspaces/workspace-access.ts": { count: 2, reason: NAMED.owner },
  "packages/server/src/workspaces/collaboration-workspace-service.ts": {
    count: 2,
    reason: NAMED.owner
  },
  "packages/chat-ui/src/admin/settings/pages/access.tsx": { count: 1, reason: NAMED.handsOut },
  "packages/chat-ui/src/admin/settings/pages/users.tsx": { count: 1, reason: NAMED.account },
  "packages/chat-ui/src/admin/control-plane/user-administration-detail.tsx": {
    count: 1,
    reason: NAMED.account
  },
  "packages/chat-ui/src/admin/control-plane/user-administration-fields.tsx": {
    count: 2,
    reason: NAMED.role
  },
  // The access level a role list is shown as, and the roles an access level stands for.
  "packages/chat-ui/src/admin/control-plane/user-administration-model.ts": {
    count: 2,
    reason: NAMED.notAGate
  },
  // The local CLI key is made for the seed's superadmin.
  "packages/client-assembly/src/local-key.ts": { count: 1, reason: NAMED.notAGate }
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function superadminChecks(): Record<string, number> {
  const packages = join(root, "packages");
  const found: Record<string, number> = {};
  for (const name of readdirSync(packages)) {
    const src = join(packages, name, "src");
    let files: string[];
    try {
      files = sourceFiles(src);
    } catch {
      continue;
    }
    for (const file of files) {
      const count = readFileSync(file, "utf8").match(SUPERADMIN_CHECK)?.length ?? 0;
      if (count > 0) found[relative(root, file)] = count;
    }
  }
  return found;
}

describe("access check 40: the named list", () => {
  it("finds every check of the superadmin role on the named list, and no other", () => {
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED).map(([file, { count }]) => [file, count])
    );
    // A file here that is not allowed holds a new hard-wired gate: make it a right with a role
    // default, or name it in the spec and here. A count that fell is a gate that left: lower it.
    expect(superadminChecks()).toEqual(allowed);
  });

  it("gives each allowed check a reason", () => {
    const reasons = new Set<string>(Object.values(NAMED));
    for (const { reason } of Object.values(ALLOWED)) expect(reasons.has(reason)).toBe(true);
  });
});

/** How the spec's sweep resolved a gate: a right a person is granted, or named. */
type Resolution =
  | { grantable: readonly ("workspace" | "asset" | "instance")[] }
  | { named: "legacy key a superadmin hands out" };

/** The sweep under "No hard-wired gates", with the default the spec gives each right. */
const SWEEP: readonly {
  action: string;
  resolution: Resolution;
  default: "admin" | "superadmin";
}[] = [
  {
    action: "workflow.publish",
    resolution: { grantable: ["asset", "workspace", "instance"] },
    default: "admin"
  },
  // Given to a person on the whole instance since RIGHTS-1f.
  {
    action: "service_principals.manage",
    resolution: { grantable: ["instance"] },
    default: "admin"
  },
  {
    action: "api_access.manage",
    resolution: { named: "legacy key a superadmin hands out" },
    default: "superadmin"
  },
  ...(["read", "write", "publish", "delete"] as const).map((verb) => ({
    action: `app.${verb}`,
    resolution: { grantable: ["workspace", "asset"] } as const,
    default: "admin" as const
  })),
  ...(["read", "write", "publish", "delete"] as const).map((verb) => ({
    action: `data_store.${verb}`,
    resolution: { grantable: ["workspace", "asset"] } as const,
    default: "admin" as const
  })),
  ...(["insert", "execute"] as const).map((verb) => ({
    action: `data_store.${verb}`,
    resolution: { grantable: ["workspace", "asset", "instance"] } as const,
    default: "admin" as const
  })),
  ...(["read", "write", "publish", "delete", "use"] as const).map((verb) => ({
    action: `knowledge_base.${verb}`,
    resolution: { grantable: ["asset"] } as const,
    default: "admin" as const
  })),
  ...(["write", "delete", "approve"] as const).map((verb) => ({
    action: `connection.${verb}`,
    resolution: { grantable: ["asset"] } as const,
    default: "admin" as const
  })),
  { action: "workflow.delete", resolution: { grantable: ["asset"] }, default: "admin" },
  { action: "workflow.read_run_data", resolution: { grantable: ["asset"] }, default: "admin" },
  { action: "jobs.retry", resolution: { grantable: ["instance"] }, default: "superadmin" },
  { action: "system.view", resolution: { grantable: ["instance"] }, default: "superadmin" },
  { action: "users.delete", resolution: { grantable: ["instance"] }, default: "superadmin" },
  {
    action: "agent_models.manage",
    resolution: { named: "legacy key a superadmin hands out" },
    default: "superadmin"
  },
  { action: "roles.edit_built_in", resolution: { grantable: ["instance"] }, default: "superadmin" }
];

describe("access check 40: the sweep", () => {
  it.each(SWEEP)("$action is a right with its default, grantable or named", (gate) => {
    expect(isPlatformAction(gate.action)).toBe(true);
    const held = (role: "admin" | "superadmin") =>
      ROLE_DEFAULT_ACTIONS[role].some((action) => action === gate.action);
    expect(held("superadmin")).toBe(true);
    expect(held("admin")).toBe(gate.default === "admin");
    if ("grantable" in gate.resolution) {
      expect(isGrantableAction(gate.action)).toBe(true);
      const scopes: readonly string[] = isGrantableAction(gate.action)
        ? GRANTABLE_ACTION_SCOPES[gate.action]
        : [];
      expect(scopes).toEqual(expect.arrayContaining([...gate.resolution.grantable]));
    } else {
      // A superadmin hands it out on the Users page, as a legacy key (D8).
      expect(isPermission(gate.action)).toBe(true);
      expect(SUPERADMIN_GRANTED_ACTIONS.some((action) => action === gate.action)).toBe(true);
    }
  });
});
