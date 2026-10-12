import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "@vivd-catalyst/api-client";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  assetIdFromTitle,
  PendingApprovalError,
  readBuildRefusal,
  refusalsOf,
  resolveBuildRights
} from "@vivd-catalyst/chat-ui/build-area";
import { createAssetWrites } from "../packages/chat-ui/src/api/asset-writes";
import {
  instanceActions,
  legalNamespace,
  platformContext,
  taxNamespace,
  type Namespaces
} from "./chat-ui-build-fixtures";

describe("Studio ids", () => {
  it("makes an id from the name people read", () => {
    expect(assetIdFromTitle("Tax Review")).toBe("tax_review");
    expect(assetIdFromTitle("  Steuer-Prüfung (Köln) 2026 ")).toBe("steuer_prufung_koln_2026");
    expect(assetIdFromTitle("Crème brûlée")).toBe("creme_brulee");
    expect(assetIdFromTitle("already_an_id")).toBe("already_an_id");
    // A name without a letter or digit gives no id: the reader types one.
    expect(assetIdFromTitle("???")).toBe("");
    expect(assetIdFromTitle("")).toBe("");
  });
});

describe("Studio rights", () => {
  const rights = (permissions: string[], namespaces: Namespaces = []) =>
    resolveBuildRights({ permissions }, platformContext(namespaces, instanceActions(permissions)));
  const taxAgent = { kind: "agent", namespace: "tax-" };
  const taxSkill = { kind: "skill", namespace: "tax-" };

  it("lets an instance reader read every kind and write nothing", () => {
    const reader = rights(["config_assets.read"]);

    expect(reader.readsAny).toBe(true);
    expect(reader.reads("agent")).toBe(true);
    expect(reader.reads("skill")).toBe(true);
    expect(reader.instanceWrite).toBe(false);
    expect(reader.may("write", taxAgent)).toBe(false);
    expect(reader.may("delete", { kind: "agent" })).toBe(false);
    expect(reader.mayCreate("agent")).toBe(false);
    expect(reader.creatableNamespaces("agent")).toEqual([]);
  });

  it("lets an instance writer write, delete and create everywhere", () => {
    const writer = rights(["config_assets.write"]);

    expect(writer.readsAny).toBe(true);
    expect(writer.reads("skill")).toBe(true);
    expect(writer.instanceWrite).toBe(true);
    expect(writer.may("write", { kind: "agent" })).toBe(true);
    expect(writer.may("delete", taxSkill)).toBe(true);
    expect(writer.mayCreate("skill")).toBe(true);
    // No Namespace is held: the dialog offers the choice of none.
    expect(writer.creatableNamespaces("skill")).toEqual([]);
  });

  it("lets a Namespace reader read the kinds its actions name and write nothing", () => {
    const reader = rights([], [legalNamespace]);

    expect(reader.readsAny).toBe(true);
    expect(reader.reads("agent")).toBe(true);
    expect(reader.reads("skill")).toBe(true);
    expect(reader.instanceWrite).toBe(false);
    expect(reader.may("write", { kind: "agent", namespace: "legal-" })).toBe(false);
    expect(reader.mayCreate("agent")).toBe(false);
    expect(reader.namespaces).toEqual([{ prefix: "legal-", displayName: "Legal" }]);
    expect(rights([], [{ ...legalNamespace, actions: ["skill.read"] }]).reads("agent")).toBe(false);
  });

  it("lets a Namespace writer write inside the Namespace, per kind and per verb", () => {
    const writer = rights([], [taxNamespace, legalNamespace]);

    expect(writer.may("write", taxAgent)).toBe(true);
    expect(writer.may("delete", taxAgent)).toBe(true);
    expect(writer.may("write", taxSkill)).toBe(false);
    expect(writer.may("write", { kind: "agent", namespace: "legal-" })).toBe(false);
    // An asset outside every Namespace belongs to the instance.
    expect(writer.may("write", { kind: "agent" })).toBe(false);
    expect(writer.may("write", { kind: "connection", namespace: "tax-" })).toBe(false);
    expect(
      rights([], [{ ...taxNamespace, actions: ["agent.write"] }]).may("delete", taxAgent)
    ).toBe(false);
  });

  it("names the Namespaces a new asset of a kind may be named in", () => {
    const writer = rights([], [taxNamespace, legalNamespace]);

    expect(writer.mayCreate("agent")).toBe(true);
    expect(writer.creatableNamespaces("agent")).toEqual([{ prefix: "tax-", displayName: "Tax" }]);
    expect(writer.mayCreate("skill")).toBe(false);
    expect(writer.creatableNamespaces("skill")).toEqual([]);
    // An instance writer who also holds a Namespace is offered it beside the choice of none.
    expect(rights(["config_assets.write"], [taxNamespace]).creatableNamespaces("agent")).toEqual([
      { prefix: "tax-", displayName: "Tax" }
    ]);
  });

  it("lets the holder of a read grant on one asset see the kind, and write nothing", () => {
    const holder = resolveBuildRights({ permissions: [] }, platformContext([], [], ["skill.read"]));

    expect(holder.readsAny).toBe(true);
    expect(holder.reads("skill")).toBe(true);
    expect(holder.reads("agent")).toBe(false);
    expect(holder.instanceWrite).toBe(false);
    expect(holder.may("write", { kind: "skill" })).toBe(false);
    expect(holder.mayCreate("skill")).toBe(false);
    expect(holder.namespaces).toEqual([]);
  });

  it("gives nobody anything: no permission, no Namespace, or no answer of the instance", () => {
    for (const nobody of [
      rights([]),
      rights(["users.manage"]),
      resolveBuildRights(undefined, undefined),
      resolveBuildRights({ permissions: [] }, undefined)
    ]) {
      expect(nobody.readsAny).toBe(false);
      expect(nobody.reads("agent")).toBe(false);
      expect(nobody.instanceWrite).toBe(false);
      expect(nobody.may("write", taxAgent)).toBe(false);
      expect(nobody.mayCreate("agent")).toBe(false);
      expect(nobody.namespaces).toEqual([]);
    }
    // The session alone opens Studio for an instance reader before the instance answered.
    expect(resolveBuildRights({ permissions: ["config_assets.read"] }, undefined).readsAny).toBe(
      true
    );
  });
});

describe("Studio refusals", () => {
  const { t } = createTranslationContext("en");
  const refusal = (code: string, message: string, details?: Record<string, unknown>) =>
    new ApiError(code === "REVISION_CONFLICT" ? 412 : code === "FORBIDDEN" ? 403 : 400, message, {
      error: { code, message, ...(details ? { details } : {}) }
    });

  it("answers a write over a newer revision as a conflict, with no sentence of its own", () => {
    const outcome = readBuildRefusal(
      refusal("REVISION_CONFLICT", "Config agent 'tax' is not at the revision the call names", {
        reason: "revision_conflict",
        conflicts: [{ kind: "agent", name: "tax" }]
      }),
      t
    );

    expect(outcome).toEqual({ ok: false, conflict: true });
    expect(refusalsOf(outcome, undefined)).toEqual([]);
    expect(refusalsOf(outcome, "tools")).toEqual([]);
  });

  // Fails without the change: a conflict told nobody who wrote the newer revision.
  it("reads who wrote the revision a conflict is with, and whether it is the delete", () => {
    const conflict = { kind: "agent", name: "tax", currentRevision: 4 };
    const changed = { changedBy: "Kai Lehmann", changedAt: "2026-10-12T09:30:00.000Z" };

    expect(
      readBuildRefusal(
        refusal("REVISION_CONFLICT", "Config agent 'tax' is at revision 4", {
          conflicts: [{ ...conflict, ...changed }]
        }),
        t
      )
    ).toEqual({ ok: false, conflict: true, currentRevision: 4, ...changed });
    expect(
      readBuildRefusal(
        refusal("REVISION_CONFLICT", "Config agent 'tax' was deleted at revision 4", {
          conflicts: [{ ...conflict, deleted: true, ...changed }]
        }),
        t
      )
    ).toEqual({ ok: false, conflict: true, deleted: true, currentRevision: 4, ...changed });
  });

  it("shows any other conflict as the instance said it", () => {
    expect(readBuildRefusal(refusal("CONFLICT", "The default agent changed"), t)).toEqual({
      ok: false,
      conflict: false,
      refusals: [{ message: "The default agent changed" }]
    });
  });

  it("puts a tool the Namespace does not allow at the tools", () => {
    const outcome = readBuildRefusal(
      refusal("FORBIDDEN", "Forbidden", {
        reason: "tool_not_allowed",
        toolName: "documents.read",
        namespace: "tax-"
      }),
      t
    );

    expect(outcome).toEqual({
      ok: false,
      conflict: false,
      refusals: [
        { field: "tools", message: "The tool documents.read is not allowed in Namespace tax-." }
      ]
    });
    expect(refusalsOf(outcome, "tools")).toHaveLength(1);
    expect(refusalsOf(outcome, "model")).toEqual([]);
    expect(refusalsOf(outcome, undefined)).toEqual([]);
  });

  it("puts a model the Namespace does not allow, and a missing one, at the model", () => {
    expect(
      readBuildRefusal(
        refusal("FORBIDDEN", "Forbidden", {
          reason: "model_not_allowed",
          modelBindingId: "reasoning",
          namespace: "tax-"
        }),
        t
      )
    ).toEqual({
      ok: false,
      conflict: false,
      refusals: [
        { field: "model", message: "The model reasoning is not allowed in Namespace tax-." }
      ]
    });
    expect(
      readBuildRefusal(
        refusal("FORBIDDEN", "Forbidden", { reason: "model_binding_required", namespace: "tax-" }),
        t
      )
    ).toEqual({
      ok: false,
      conflict: false,
      refusals: [
        {
          field: "model",
          message: "An agent in Namespace tax- needs a default model the Namespace allows."
        }
      ]
    });
  });

  it("tells a refusal from a Namespace's lists in the reader's language", () => {
    const outcome = readBuildRefusal(
      refusal("FORBIDDEN", "Forbidden", {
        reason: "tool_not_allowed",
        toolName: "documents.read",
        namespace: "tax-"
      }),
      createTranslationContext("de").t
    );

    expect(refusalsOf(outcome, "tools")).toEqual([
      "Das Werkzeug documents.read ist im Namespace tax- nicht erlaubt."
    ]);
  });

  it("sends each issue of a definition to the field its path names", () => {
    const outcome = readBuildRefusal(
      refusal("VALIDATION_FAILED", "The definition is invalid", {
        issues: [
          { message: "Tool 'nope' is not registered", path: ["toolNames", 2] },
          { message: "Skill 'gone' does not exist", path: ["config", "skillNames", 0] },
          { message: "Reasoning effort 'max' is not offered", path: ["reasoningEffort"] },
          {
            message: "Model binding 'x' does not exist",
            path: ["userSelectableModelBindingIds", 0]
          },
          { message: "Instructions must not be empty", path: ["instructions"] },
          { message: "The definition names no title" },
          { path: ["toolNames"] }
        ]
      }),
      t
    );

    expect(refusalsOf(outcome, "tools")).toEqual(["Tool 'nope' is not registered"]);
    expect(refusalsOf(outcome, "skills")).toEqual(["Skill 'gone' does not exist"]);
    expect(refusalsOf(outcome, "model")).toEqual([
      "Reasoning effort 'max' is not offered",
      "Model binding 'x' does not exist"
    ]);
    // An issue of a field without a place of its own, or without a path, shows above the save bar.
    expect(refusalsOf(outcome, undefined)).toEqual([
      "Instructions must not be empty",
      "The definition names no title"
    ]);
  });

  it("says that a change waits for an approval", () => {
    expect(readBuildRefusal(new PendingApprovalError(), t)).toEqual({
      ok: false,
      conflict: false,
      refusals: [
        {
          message:
            "This change waits for an approval. Nothing was changed yet and your text is still here."
        }
      ]
    });
  });

  it("shows every other sentence as the instance said it", () => {
    const unread = "The change would break an asset the caller may not read";

    expect(readBuildRefusal(refusal("VALIDATION_FAILED", unread), t)).toEqual({
      ok: false,
      conflict: false,
      refusals: [{ message: unread }]
    });
    expect(
      refusalsOf(
        readBuildRefusal(
          refusal("VALIDATION_FAILED", "The definition is invalid", {
            issues: [{ message: unread, path: [] }]
          }),
          t
        ),
        undefined
      )
    ).toEqual([unread]);
    // A refusal for a reason this page has no sentence for keeps the instance's own.
    expect(
      refusalsOf(
        readBuildRefusal(
          refusal("FORBIDDEN", "Agent 'tax-a' may not be the default", { reason: "other" }),
          t
        ),
        undefined
      )
    ).toEqual(["Agent 'tax-a' may not be the default"]);
    expect(refusalsOf(readBuildRefusal(new Error("Network down"), t), undefined)).toEqual([
      "Network down"
    ]);
    expect(refusalsOf(readBuildRefusal(undefined, t), undefined)).toEqual([
      "The change could not be saved."
    ]);
  });

  it("answers a saved change with no refusal", () => {
    expect(refusalsOf({ ok: true }, undefined)).toEqual([]);
    expect(refusalsOf(undefined, "tools")).toEqual([]);
  });
});

describe("asset writes", () => {
  /** A client whose requests are recorded and answered as a write that was made. */
  function recordingWrites() {
    /** `asset` is the request's address below the root of the asset operations. */
    const requests: { method: string; asset: string; body: unknown }[] = [];
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const body: unknown = JSON.parse(await request.text());
        const asset = new URL(request.url).pathname.replace(/^.*\/assets\//u, "");
        requests.push({ method: request.method, asset, body });
        return Response.json({ version: 9, revision: 8, warnings: [] });
      }
    });
    return { writes: createAssetWrites(client), requests };
  }
  const address = { kind: "agent", name: "tax-assistant" };

  it("names exactly the revision it is handed, however often it is asked", async () => {
    const { writes, requests } = recordingWrites();
    const config = { name: "tax-assistant", instructions: "Help." };

    // A page that loaded revision 3 keeps writing against 3, whatever was saved since.
    await writes.put({ ...address, config, expectedRevision: 3 });
    await writes.put({ ...address, config, expectedRevision: 3 });
    await writes.revert({ ...address, revision: 1, expectedRevision: 3 });
    await writes.delete({ ...address, expectedRevision: 3 });

    expect(requests).toEqual([
      {
        method: "PUT",
        asset: "agent/tax-assistant",
        body: { config, expectedRevision: 3 }
      },
      {
        method: "PUT",
        asset: "agent/tax-assistant",
        body: { config, expectedRevision: 3 }
      },
      {
        method: "POST",
        asset: "agent/tax-assistant/revert",
        body: { revision: 1, expectedRevision: 3 }
      },
      {
        method: "POST",
        asset: "agent/tax-assistant/delete",
        body: { expectedRevision: 3 }
      }
    ]);
  });

  it("names null for the revision when it creates an asset", async () => {
    const { writes, requests } = recordingWrites();
    const config = { name: "tax-assistant" };

    const outcome = await writes.put({ ...address, config, expectedRevision: null });

    expect(requests).toEqual([
      { method: "PUT", asset: "agent/tax-assistant", body: { config, expectedRevision: null } }
    ]);
    expect(outcome).toMatchObject({ status: "done", output: { revision: 8 } });
  });
});
