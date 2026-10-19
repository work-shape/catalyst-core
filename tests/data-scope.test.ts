import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  createActorAccess,
  resolveDataScope,
  viewerScopeBindings,
  type ScopeAssignmentInput
} from "@work-shape/catalyst-core";

const assignment = (input: Partial<ScopeAssignmentInput> = {}): ScopeAssignmentInput => ({
  dimension: "mandant",
  holderKind: "user",
  holderId: "reader",
  effect: "allow",
  values: ["101"],
  ...input
});

describe("the data scope resolver", () => {
  it("unions the person's values and group values, then applies their revocation", () => {
    expect(
      resolveDataScope(
        [
          assignment(),
          assignment({ holderKind: "group", values: ["102", "103"] }),
          assignment({ effect: "deny", values: ["103"] })
        ],
        "mandant"
      )
    ).toEqual(["101", "102"]);
  });
  it("has no implicit all, even for an admin, and an inactive holder sees no data", () => {
    const holder = {
      kind: "user" as const,
      id: "admin",
      clientInstanceId: asClientInstanceId("scope"),
      roles: ["superadmin"],
      permissionRefs: []
    };
    expect(
      createActorAccess(holder, { holderActive: true, grants: [] }).scopeOf("mandant")
    ).toEqual([]);
    expect(
      createActorAccess(holder, {
        holderActive: false,
        grants: [],
        scopeAssignments: [assignment({ values: "all" })]
      }).scopeOf("mandant")
    ).toEqual([]);
    expect(resolveDataScope([assignment({ values: "all" })], "mandant")).toBe("all");
    expect(
      resolveDataScope(
        [assignment({ values: "all" }), assignment({ effect: "deny", values: "all" })],
        "mandant"
      )
    ).toEqual([]);
    expect(resolveDataScope([assignment()], "other")).toEqual([]);
  });
  it("binds executable viewer tokens, with no bindings in comments, text or identifiers", () => {
    const sql = `select '$viewer.scope(\'fake\')', "$viewer.scope('fake')", $$ $viewer.scope('fake') $$, $viewer.scope('mandant'), $viewer.scope_all('mandant') /* nested /* $viewer.scope('fake') */ */ -- $viewer.scope('fake')`;
    expect(viewerScopeBindings(sql).map(({ dimension, all }) => ({ dimension, all }))).toEqual([
      { dimension: "mandant", all: false },
      { dimension: "mandant", all: true }
    ]);
  });
  it.each(["$viewer.scope", "$viewer.scope(user_input)", "/* never closed", "'never closed"])(
    "refuses malformed SQL binding text %s",
    (sql) => {
      expect(() => viewerScopeBindings(sql)).toThrow();
    }
  );
});
