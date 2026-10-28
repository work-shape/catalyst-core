import { describe, expect, it } from "vitest";
import {
  asCollaborationWorkspaceId,
  ownerReachRefusal,
  type AgentAvailability,
  type AssetOwnerReach,
  type OwnerReachUse
} from "@work-shape/catalyst-core";

// The one decision of who may rely on what (2026-10-28 cross-scope reference audit): something
// shared never relies on or exposes something a Personal Workspace owns. One row per pair of
// the audit's matrix, from each owner, so a change of the decision shows which pair moved.

const instance: AssetOwnerReach = { kind: "instance" };
const team: AssetOwnerReach = { kind: "workspace", workspaceId: "team", workspaceKind: "shared" };
const other: AssetOwnerReach = { kind: "workspace", workspaceId: "other", workspaceKind: "shared" };
const mine: AssetOwnerReach = {
  kind: "workspace",
  workspaceId: "mine",
  workspaceKind: "personal"
};
const theirs: AssetOwnerReach = {
  kind: "workspace",
  workspaceId: "theirs",
  workspaceKind: "personal"
};
/** A workspace whose row is gone reaches no further than a Personal Workspace. */
const unknown: AssetOwnerReach = {
  kind: "workspace",
  workspaceId: "gone",
  workspaceKind: undefined
};

const owners = { instance, team, other, mine, theirs, unknown };
type OwnerName = keyof typeof owners;
const OWNER_NAMES: OwnerName[] = ["instance", "team", "other", "mine", "theirs", "unknown"];

/** Each reference pair of the audit, and whether its source kind trusts run-time grants. */
const REFERENCE_PAIRS: { pair: string; acrossOwners: boolean }[] = [
  { pair: "agent → skill", acrossOwners: false },
  { pair: "agent → Knowledge Base", acrossOwners: false },
  { pair: "agent → Data Store, Workflow, App or Connection tool", acrossOwners: false },
  { pair: "agent → subagent", acrossOwners: false },
  { pair: "App → Workflow, Data Store or Connection action", acrossOwners: false },
  { pair: "Workflow → child Workflow or onFailure", acrossOwners: false },
  { pair: "Workflow → Data Store, Knowledge Base or App", acrossOwners: true },
  { pair: "Knowledge Base → Data Store or Connection", acrossOwners: false }
];

/** Who may name whom: the source's owner, then each target's owner it may name. */
const NAMES: Record<OwnerName, OwnerName[]> = {
  instance: ["instance"],
  team: ["instance", "team"],
  other: ["instance", "other"],
  mine: ["instance", "mine"],
  theirs: ["instance", "theirs"],
  unknown: ["instance", "unknown"]
};

describe("ownerReachRefusal: references", () => {
  for (const { pair, acrossOwners } of REFERENCE_PAIRS) {
    it(`${pair}: a source names its own owner's assets and the instance's${acrossOwners ? ", and an instance source a Shared Workspace's" : ""}, never a Personal Workspace's from outside it`, () => {
      const decided = Object.fromEntries(
        OWNER_NAMES.map((source) => [
          source,
          OWNER_NAMES.filter(
            (target) =>
              ownerReachRefusal(owners[source], {
                kind: "reference",
                target: owners[target],
                acrossOwners
              }) === undefined
          )
        ])
      );
      expect(decided).toEqual({
        ...NAMES,
        // G4: the instance Workflow's exception covers Shared Workspaces, never personal ones.
        ...(acrossOwners ? { instance: ["instance", "team", "other"] } : {})
      });
    });
  }

  it("refuses a reference with invalid_scope, the reason every save path already gives", () => {
    const use: OwnerReachUse = { kind: "reference", target: mine, acrossOwners: true };
    expect(ownerReachRefusal(instance, use)).toBe("invalid_scope");
    expect(ownerReachRefusal(team, use)).toBe("invalid_scope");
  });

  it("Workflow → Connection: a Connection is the instance's, so every source names it", () => {
    for (const source of Object.values(owners))
      expect(ownerReachRefusal(source, { kind: "reference", target: instance })).toBeUndefined();
  });
});

const nowhere: AgentAvailability = {
  mode: "selected",
  personalWorkspaces: false,
  collaborationWorkspaceIds: []
};
const OFFERS: Record<string, AgentAvailability> = {
  nowhere,
  "in a Shared Workspace": {
    ...nowhere,
    collaborationWorkspaceIds: [asCollaborationWorkspaceId("team")]
  },
  "in every Personal Workspace": { ...nowhere, personalWorkspaces: true },
  everywhere: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
};

describe("ownerReachRefusal: offers", () => {
  // Agents, subagents (an agent offered on its own), Knowledge Bases, and the dependencies an
  // agent's availability widens: one availability, one decision.
  for (const kind of ["agent", "subagent", "Knowledge Base", "dependency of an agent"])
    it(`${kind}: a Personal Workspace's is offered nowhere beyond its owner; every other owner's as an admin sets it`, () => {
      for (const [name, availability] of Object.entries(OFFERS)) {
        for (const source of [mine, theirs, unknown])
          expect(ownerReachRefusal(source, { kind: "availability", availability }), name).toBe(
            name === "nowhere" ? undefined : "owner_reach"
          );
        // A Shared Workspace's asset offered beyond it stays allowed (decision, 2026-10-28).
        for (const source of [instance, team, other])
          expect(
            ownerReachRefusal(source, { kind: "availability", availability }),
            name
          ).toBeUndefined();
      }
    });

  it("App audience: a Personal Workspace's App is never for the whole instance (G3, MOVE-1)", () => {
    for (const source of [mine, unknown]) {
      expect(ownerReachRefusal(source, { kind: "app_audience", audience: "instance" })).toBe(
        "app_instance_needs_shared_workspace"
      );
      for (const audience of ["self", "workspace"] as const)
        expect(ownerReachRefusal(source, { kind: "app_audience", audience })).toBeUndefined();
    }
    // SHARE-1: a Shared Workspace's App goes to the whole instance.
    for (const source of [instance, team])
      for (const audience of ["self", "workspace", "instance"] as const)
        expect(ownerReachRefusal(source, { kind: "app_audience", audience })).toBeUndefined();
  });
});
