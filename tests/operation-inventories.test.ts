import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiOperations,
  isRegisteredOperation,
  type ApiOperationName,
  type Operation
} from "@work-shape/catalyst-api-contract";

const names = Object.keys(apiOperations).filter(
  (name): name is ApiOperationName => name in apiOperations
);
const descriptor = (name: ApiOperationName): Operation => apiOperations[name];

// The list of plain operations is data a person reads: which changing operations are not an
// Operation Run and why, and where the right of an operation without `requires` is decided.
// These tests read the catalog and two files and need no database.
describe("a changing operation is registered or named as plain", () => {
  const readJson = (path: string): unknown =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  // There is no class for an operation that waits to be registered: a changing operation is an
  // Operation Run, or it is plain for a reason that stays true.
  const classes = ["identity", "own_account", "decision", "conversation"] as const;
  const list = z
    .strictObject({
      changing: z.record(
        z.string(),
        z.strictObject({ class: z.enum(classes), reason: z.string().trim().min(1) })
      ),
      rightDecidedBy: z.record(
        z.string(),
        // `asset_right`: the handler asks for an action of an asset kind, on the instance, a
        // workspace or one asset (`registerPlatformRoutes` in server/src/routes/platform-routes.ts).
        // `holder_right`: the handler checks own rights or administration of the named holder.
        z.enum([
          "workspace_role",
          "conversation_access",
          "own",
          "public",
          "asset_right",
          "holder_right"
        ])
      )
    })
    .parse(readJson("../packages/quality-config/plain-changing-operations.json"));
  const baseline = z
    .object({
      entries: z.array(
        z.object({ target: z.string(), rule: z.string(), scope: z.string(), count: z.number() })
      )
    })
    .parse(readJson("../quality-baseline.json"));
  const plain = names.filter((name) => !isRegisteredOperation(descriptor(name)));
  const plainChanging = plain.filter((name) => descriptor(name).effect === "changing");
  const withoutRequires = plain.filter((name) => !descriptor(name).requires?.length);

  it("names every plain changing operation, and nothing registered, reading or gone", () => {
    expect(Object.keys(list.changing).sort()).toEqual([...plainChanging].sort());
  });

  // FU-1a F4/F5 explicitly approves these new unaudited queue controls, and FU-2 the queued
  // message's Steer now, whose steer is audited as `message.created` once the run takes it in.
  // They are not pre-existing plain operations. Keep this reviewed allowance finite; adding
  // another plain operation still exceeds the unchanged baseline below.
  const approvedFollowUpControls = new Set<string>([
    "conversations.follow_ups.withdraw",
    "conversations.follow_ups.dispatch",
    "conversations.follow_ups.steer"
  ]);
  it("keeps the approved follow-up controls changing, unaudited and conversation-authorized", () => {
    for (const name of approvedFollowUpControls) {
      expect(list.changing[name]).toMatchObject({ class: "conversation" });
      expect(list.rightDecidedBy[name]).toBe("conversation_access");
      expect(plainChanging).toContain(name);
    }
  });

  // A count may only fall: the baseline guard refuses a pull request that raises one, so an
  // operation cannot be moved into a class that stays plain without that being seen.
  it.each(classes)("counts the class %s as the baseline does", (kind) => {
    const counted = Object.entries(list.changing).filter(
      ([name, entry]) => entry.class === kind && !approvedFollowUpControls.has(name)
    ).length;
    const recorded = baseline.entries
      .filter((entry) => entry.target === "operations" && entry.rule === "plain-changing")
      .find((entry) => entry.scope === kind);
    // The baseline leaves out a count of zero.
    expect({ class: kind, count: counted }).toEqual({ class: kind, count: recorded?.count ?? 0 });
  });

  it("names where the right of every plain operation without requires is decided", () => {
    expect(Object.keys(list.rightDecidedBy).sort()).toEqual([...withoutRequires].sort());
  });
});
