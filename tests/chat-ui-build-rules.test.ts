import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "@work-shape/catalyst-api-client";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  ASSET_ADDRESS_MAX_LENGTH,
  ASSET_ADDRESS_PATTERN,
  assetAddressFromName
} from "@work-shape/catalyst-core";
import { addressOf } from "@work-shape/catalyst-ui";
import {
  addressBlocksCreate,
  addressCheckOf,
  approverNamesOf,
  buildScopes,
  PendingApprovalError,
  mayCreateAgents,
  readBuildRefusal,
  refusalsOf,
  resolveBuildRights,
  resolveBuildScope
} from "@work-shape/catalyst-chat-ui/build-area";
import { createAssetWrites } from "./support/chat-ui";
import {
  instanceActions,
  legalWorkspace,
  platformContext,
  taxWorkspace,
  type Workspaces
} from "./chat-ui-build-fixtures";

// ACCEPT-FIX-1 F2: every create dialog makes the address by the one rule the strictest kind
// holds, so the address it suggests is never refused. Fails with the old generator, which
// joined words by '_' that a Knowledge Base, Data Store and App refuse.
describe("Studio ids", () => {
  const address = (name: string) => assetAddressFromName(name, "knowledge_base");

  it("makes an address from the name people read", () => {
    expect(address("ACCEPT Nordlicht Wissen")).toBe("accept-nordlicht-wissen");
    // German letters keep their sound; other accents are dropped.
    expect(address("  Steuer-Prüfung (Köln) 2026 ")).toBe("steuer-pruefung-koeln-2026");
    expect(address("Crème brûlée")).toBe("creme-brulee");
    expect(address("Straße & Gärten")).toBe("strasse-gaerten");
    expect(address("already_an_id")).toBe("already-an-id");
    // A long name is cut at the limit, and the cut never ends on '-'.
    const long = address("Wissen ".repeat(20));
    expect(long.length).toBeLessThanOrEqual(ASSET_ADDRESS_MAX_LENGTH);
    expect(long).toMatch(ASSET_ADDRESS_PATTERN);
  });

  it("starts with the kind's word where the name does not start with a letter", () => {
    expect(address("2026 Jahresplan")).toBe("knowledge-base-2026-jahresplan");
    expect(address("2026")).toBe("knowledge-base-2026");
    expect(address("???")).toBe("knowledge-base");
    expect(assetAddressFromName("3. Quartal", "agent")).toBe("agent-3-quartal");
    // Only an empty name makes no address.
    expect(address("   ")).toBe("");
    expect(address("")).toBe("");
  });
});

// UXA-2: a new asset asks for the name, and its address follows it until somebody types one.
// Fails without the change: the dialogs held the id as a field of its own, checked by nothing
// before the save.
describe("the address of a new asset", () => {
  const address = (name: string) => assetAddressFromName(name, "agent");

  it("follows the name until it is edited by hand, and then stays as typed", () => {
    expect(addressOf({ name: "Tax Review" }, address)).toBe("tax-review");
    expect(addressOf({ name: "Tax Review 2026" }, address)).toBe("tax-review-2026");
    const typed = { name: "Tax Review", typedAddress: "tax" };
    expect(addressOf(typed, address)).toBe("tax");
    expect(addressOf({ ...typed, name: "Steuer-Prüfung" }, address)).toBe("tax");
    // Emptied by hand it stays empty, so it does not jump back while the person retypes it.
    expect(addressOf({ name: "Tax Review", typedAddress: "" }, address)).toBe("");
  });

  it("names why an address is refused, in the reader's language, and blocks the create", () => {
    const en = createTranslationContext("en").t;
    const de = createTranslationContext("de").t;
    const taken = { ok: true as const, found: refusedName("name_taken") };
    const invalid = { ok: true as const, found: refusedName("name_invalid") };
    expect(addressCheckOf(taken, en)).toEqual({
      state: "refused",
      reason: "This address is taken. Choose another name or address."
    });
    expect(addressCheckOf(taken, de)).toEqual({
      state: "refused",
      reason: "Diese Adresse ist vergeben. Wähle einen anderen Namen oder eine andere Adresse."
    });
    // The reason says the rule the dialog makes addresses by, with its limit.
    expect(addressCheckOf(invalid, en)).toEqual({
      state: "refused",
      reason:
        "This address does not work. Use lowercase letters and digits in words joined by -, starting with a letter, at most 63 characters."
    });
    expect(addressCheckOf(invalid, de)).toEqual({
      state: "refused",
      reason:
        "Diese Adresse geht so nicht. Nimm Kleinbuchstaben und Ziffern in Wörtern, die - verbindet, am Anfang einen Buchstaben, höchstens 63 Zeichen."
    });
    expect(addressCheckOf({ ok: true, found: { available: true } }, en)).toEqual({
      state: "free"
    });
    // A refusal of the check itself is the instance's sentence; a lost connection says
    // nothing of the name, and the create meets the instance's answer.
    const forbidden = new ApiError(403, "Missing permission agent.write", {
      error: { code: "FORBIDDEN", message: "Missing permission agent.write" }
    });
    expect(addressCheckOf({ ok: false, error: forbidden }, en)).toEqual({
      state: "refused",
      reason: "Missing permission agent.write"
    });
    expect(addressCheckOf({ ok: false, error: new TypeError("Failed to fetch") }, en)).toEqual({
      state: "unchecked"
    });

    expect(addressBlocksCreate({ state: "checking" })).toBe(false);
    expect(addressBlocksCreate({ state: "refused", reason: "taken" })).toBe(true);
    expect(addressBlocksCreate({ state: "free" })).toBe(false);
    expect(addressBlocksCreate({ state: "unchecked" })).toBe(false);
  });

  it("asks the instance with the name and the owner Studio writes in", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, body: JSON.parse(await request.text()) });
        return Response.json({ available: true });
      }
    });
    await expect(
      createAssetWrites(client).checkName({
        kind: "agent",
        name: "tax_review",
        workspaceId: "cws_team"
      })
    ).resolves.toEqual({ available: true });
    expect(calls).toEqual([
      {
        url: "https://chat.example/api/v1/assets/agent/check-name",
        body: { name: "tax_review", workspaceId: "cws_team" }
      }
    ]);
  });
});

function refusedName(reason: "name_invalid" | "name_taken") {
  return { available: false as const, reason, message: "The instance's own sentence" };
}

describe("Studio rights", () => {
  const rights = (permissions: string[], workspaces: Workspaces = []) =>
    resolveBuildRights({ permissions }, platformContext(workspaces, instanceActions(permissions)));
  const taxAgent = { kind: "agent", workspaceId: "ws-tax" };
  const taxSkill = { kind: "skill", workspaceId: "ws-tax" };

  it("lets an instance reader read every kind and write nothing", () => {
    const reader = rights(["config_assets.read"]);

    expect(reader.readsAny).toBe(true);
    expect(reader.reads("agent")).toBe(true);
    expect(reader.reads("skill")).toBe(true);
    expect(reader.instanceWrite).toBe(false);
    expect(reader.may("write", taxAgent)).toBe(false);
    expect(reader.may("delete", { kind: "agent" })).toBe(false);
    expect(reader.mayCreate("agent")).toBe(false);
  });

  it("lets an instance writer write, delete and create everywhere", () => {
    const writer = rights(["config_assets.write"]);

    expect(writer.readsAny).toBe(true);
    expect(writer.reads("skill")).toBe(true);
    expect(writer.instanceWrite).toBe(true);
    expect(writer.may("write", { kind: "agent" })).toBe(true);
    expect(writer.may("delete", taxSkill)).toBe(true);
    expect(writer.mayCreate("skill")).toBe(true);
    expect(writer.mayCreate("skill", "ws-tax")).toBe(true);
  });

  it("lets only a holder of agent.publish publish an agent, as the instance does (AD-4)", () => {
    const permissions = ["config_assets.write"];
    const writer = rights(permissions);
    const publisher = resolveBuildRights(
      { permissions },
      platformContext([], [...instanceActions(permissions), "agent.publish"])
    );

    expect(writer.may("write", { kind: "agent" })).toBe(true);
    expect(writer.may("publish", { kind: "agent" })).toBe(false);
    expect(publisher.may("publish", { kind: "agent" })).toBe(true);
    // A kind that names no publish right is published with the write right, as before.
    expect(writer.may("publish", { kind: "skill" })).toBe(true);
  });

  it("lets a workspace reader read the kinds its actions name and write nothing", () => {
    const reader = rights([], [legalWorkspace]);

    expect(reader.readsAny).toBe(true);
    expect(reader.reads("agent")).toBe(true);
    expect(reader.reads("skill")).toBe(true);
    expect(reader.instanceWrite).toBe(false);
    expect(reader.readsInstance).toBe(false);
    expect(reader.may("write", { kind: "agent", workspaceId: "ws-legal" })).toBe(false);
    expect(reader.mayCreate("agent", "ws-legal")).toBe(false);
    expect(reader.workspaces).toEqual([{ id: "ws-legal", name: "Legal", member: true }]);
    expect(rights([], [{ ...legalWorkspace, actions: ["skill.read"] }]).reads("agent")).toBe(false);
  });

  it("lets a workspace writer write what the workspace owns, per kind and per verb", () => {
    const writer = rights([], [taxWorkspace, legalWorkspace]);

    expect(writer.may("write", taxAgent)).toBe(true);
    expect(writer.may("delete", taxAgent)).toBe(true);
    expect(writer.may("write", taxSkill)).toBe(false);
    expect(writer.may("write", { kind: "agent", workspaceId: "ws-legal" })).toBe(false);
    // An asset the instance owns is no workspace's.
    expect(writer.may("write", { kind: "agent" })).toBe(false);
    expect(writer.may("write", { kind: "connection", workspaceId: "ws-tax" })).toBe(false);
    expect(
      rights([], [{ ...taxWorkspace, actions: ["agent.write"] }]).may("delete", taxAgent)
    ).toBe(false);
  });

  it("lets an agent be started by a writer on an instance that lets agents be created", () => {
    const on = { allowAgentCreation: true };

    expect(mayCreateAgents(rights(["config_assets.write"]), on)).toBe(true);
    // The right alone is not enough: the instance has its own switch.
    expect(mayCreateAgents(rights(["config_assets.write"]), { allowAgentCreation: false })).toBe(
      false
    );
    expect(mayCreateAgents(rights(["config_assets.write"]), undefined)).toBe(false);
    // Nor is the switch: a reader, and a reader in a workspace, start nothing.
    expect(mayCreateAgents(rights(["config_assets.read"]), on)).toBe(false);
    expect(mayCreateAgents(rights([], [legalWorkspace]), on)).toBe(false);
  });

  it("lets a new asset be started in a workspace whose kind the reader writes there", () => {
    const writer = rights([], [taxWorkspace, legalWorkspace]);

    expect(writer.mayCreate("agent", "ws-tax")).toBe(true);
    expect(writer.mayCreate("skill", "ws-tax")).toBe(false);
    expect(writer.mayCreate("agent", "ws-legal")).toBe(false);
    // Among the instance's own assets it takes the right on all of them.
    expect(writer.mayCreate("agent")).toBe(false);
  });

  it("lets the holder of a read grant on one asset see the kind, and write nothing", () => {
    const holder = resolveBuildRights({ permissions: [] }, platformContext([], [], ["skill.read"]));

    expect(holder.readsAny).toBe(true);
    expect(holder.reads("skill")).toBe(true);
    expect(holder.reads("agent")).toBe(false);
    expect(holder.instanceWrite).toBe(false);
    expect(holder.may("write", { kind: "skill" })).toBe(false);
    expect(holder.mayCreate("skill")).toBe(false);
  });

  it("gives nobody anything: no permission, no workspace right, or no answer of the instance", () => {
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
      expect(nobody.workspaces).toEqual([]);
    }
    // The session alone opens Studio for an instance reader before the instance answered.
    expect(resolveBuildRights({ permissions: ["config_assets.read"] }, undefined).readsAny).toBe(
      true
    );
  });
});

describe("Studio scope", () => {
  const team = { id: "cws_team", name: "Team", kind: "shared" as const };
  const inTeam = (actions: string[], permissions: string[] = []) =>
    resolveBuildRights(
      { permissions },
      {
        ...platformContext([], instanceActions(permissions)),
        workspaces: [
          { ...team, member: true, actions },
          // The reader's Personal Workspace is a scope of Studio beside the others, named
          // "Personal": what the reader's agent made there is found and changed there.
          {
            id: "cws_mine",
            name: "Mine",
            kind: "personal",
            member: true,
            actions: ["agent.write"]
          }
        ]
      }
    );

  it("lets a holder of rights in a workspace read and write what it owns, and nothing of the instance", () => {
    const member = inTeam(["agent.read", "agent.write", "skill.read"]);

    expect(member.readsAny).toBe(true);
    expect(member.readsInstance).toBe(false);
    expect(member.workspaces).toEqual([
      { id: "cws_team", name: "Team", member: true },
      { id: "cws_mine", name: "Mine", member: true, personal: true }
    ]);
    expect(member.reads("agent")).toBe(true);
    expect(member.may("write", { kind: "agent", workspaceId: "cws_team" })).toBe(true);
    expect(member.may("delete", { kind: "agent", workspaceId: "cws_team" })).toBe(false);
    expect(member.may("write", { kind: "skill", workspaceId: "cws_team" })).toBe(false);
    expect(member.may("write", { kind: "agent", workspaceId: "cws_mine" })).toBe(true);
    expect(member.may("write", { kind: "agent", workspaceId: "cws_other" })).toBe(false);
    expect(member.may("write", { kind: "agent" })).toBe(false);
    expect(member.mayCreate("agent", "cws_team")).toBe(true);
    expect(member.mayCreate("agent")).toBe(false);
    expect(buildScopes(member)).toEqual([
      { kind: "workspace", workspaceId: "cws_team" },
      { kind: "workspace", workspaceId: "cws_mine" }
    ]);
    expect(resolveBuildScope(member, undefined, undefined)).toEqual({
      kind: "workspace",
      workspaceId: "cws_team"
    });
  });

  it("offers the instance first, then each workspace, and keeps the scope chosen last", () => {
    const admin = inTeam(["agent.read", "agent.write"], ["config_assets.write"]);

    expect(buildScopes(admin)).toEqual([
      { kind: "instance" },
      { kind: "workspace", workspaceId: "cws_team" },
      { kind: "workspace", workspaceId: "cws_mine" }
    ]);
    expect(resolveBuildScope(admin, undefined, "cws_team")).toEqual({ kind: "instance" });
    expect(resolveBuildScope(admin, "cws_team", undefined)).toEqual({
      kind: "workspace",
      workspaceId: "cws_team"
    });
    // A scope no longer offered falls back to the first.
    expect(resolveBuildScope(admin, "cws_gone", undefined)).toEqual({ kind: "instance" });
    // An instance writer writes in every workspace.
    expect(admin.may("delete", { kind: "skill", workspaceId: "cws_team" })).toBe(true);
  });
});

describe("Studio refusals", () => {
  const { t } = createTranslationContext("en");
  const refusal = (code: string, message: string, details?: Record<string, unknown>) =>
    new ApiError(code === "REVISION_CONFLICT" ? 412 : code === "FORBIDDEN" ? 403 : 400, message, {
      error: { code, message, ...(details ? { details } : {}) }
    });

  it.each(["en", "de"] as const)("explains the person context App refusal in %s", (locale) => {
    const { t: translate } = createTranslationContext(locale);
    const outcome = readBuildRefusal(
      refusal("VALIDATION_FAILED", "Server sentence", { reason: "person_context_app_unavailable" }),
      translate,
      locale
    );
    expect(refusalsOf(outcome, undefined)).toEqual([
      locale === "en"
        ? "Person context is not available in Apps yet. Remove App exposure or the person context header."
        : "Personenkontext ist in Apps noch nicht verfügbar. Entfernen Sie die App-Freigabe oder den Header für den Personenkontext."
    ]);
  });

  // STORE-PAGES: a Data Store still used is not deleted. The reader is told so in their own
  // words, and the instance's sentence, which may name assets hidden from them, is not shown.
  it.each(["en", "de"] as const)("says a Data Store in use stays, in %s", (locale) => {
    const { t: translate } = createTranslationContext(locale);
    const outcome = readBuildRefusal(
      refusal("VALIDATION_FAILED", "Data Store 'leads' is used by app 'secret-board'", {
        reason: "data_store_in_use"
      }),
      translate,
      locale
    );
    const said = refusalsOf(outcome, undefined);
    expect(said).toEqual([
      locale === "en"
        ? "This data store is still in use, so nothing was deleted. Stop using it in the apps, workflows, agents and knowledge bases that use it, then delete it."
        : "Dieser Datenspeicher wird noch verwendet, daher wurde nichts gelöscht. Entferne ihn aus den Apps, Workflows, Agenten und Wissensbasen, die ihn verwenden, und lösche ihn dann."
    ]);
    expect(said.join(" ")).not.toContain("secret-board");
    expect(outcome).not.toMatchObject({ refusals: [{ detail: expect.anything() }] });
  });

  it.each(["en", "de"] as const)(
    "names a blocking guardrail by its title in %s, with its author's reason (ACCEPT-FIX-10 E8)",
    (locale) => {
      const { t: translate } = createTranslationContext(locale);
      const blocked = (details: Record<string, unknown>) =>
        refusalsOf(
          readBuildRefusal(
            refusal("GUARDRAIL_BLOCKED", "Guardrail 'no-iban' blocked skill 'report'", details),
            translate,
            locale
          ),
          undefined
        );
      const reason = "Assets hold no bank account numbers.";
      expect(
        blocked({ guardrailId: "no-iban", guardrailTitle: "Keine IBAN", guardrailReason: reason })
      ).toEqual([
        locale === "en"
          ? `The guardrail “Keine IBAN” stopped this change. ${reason}`
          : `Die Leitplanke „Keine IBAN“ hat diese Änderung verhindert. ${reason}`
      ]);
      // Without a title the instance's sentence stands as it came.
      expect(blocked({ guardrailId: "no-iban" })).toEqual([
        "Guardrail 'no-iban' blocked skill 'report'"
      ]);
    }
  );

  // ACCEPT-2d E-1: a new agent's consent that the instance no longer holds is told as a check
  // to make again, in the reader's language, never as the instance's English sentence.
  it.each([
    ["PRECONDITION_REQUIRED", "dependency_availability_review_required", "en"],
    ["CONFLICT", "dependency_availability_changed", "en"],
    ["CONFLICT", "dependency_availability_changed", "de"]
  ] as const)("asks for the check again on %s %s (%s)", (code, reason, locale) => {
    const { t: translate } = createTranslationContext(locale);
    const outcome = readBuildRefusal(
      refusal(code, "Review the new agent's workspace availability", { reason }),
      translate,
      locale
    );
    expect(refusalsOf(outcome, undefined)).toEqual([
      locale === "en"
        ? "Where this agent will be available changed after you checked what it uses. Nothing was created. Create it again to check the list once more."
        : "Wo dieser Agent verfügbar sein wird, hat sich nach deiner Prüfung geändert. Es wurde nichts erstellt. Erstelle ihn noch einmal, um die Liste erneut zu prüfen."
    ]);
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
      refusals: [{ message: "The default agent changed", asSent: true }]
    });
  });

  it("puts a tool the workspace does not allow at the tools", () => {
    const outcome = readBuildRefusal(
      refusal("FORBIDDEN", "Forbidden", {
        reason: "tool_not_allowed",
        toolName: "documents.read",
        workspaceId: "ws-tax",
        workspace: "Tax"
      }),
      t
    );

    expect(outcome).toEqual({
      ok: false,
      conflict: false,
      refusals: [
        {
          field: "tools",
          message:
            "The tool documents.read is not allowed in the workspace Tax. An instance admin sets its tools on Instance > Workspaces."
        }
      ]
    });
    expect(refusalsOf(outcome, "tools")).toHaveLength(1);
    expect(refusalsOf(outcome, "model")).toEqual([]);
    expect(refusalsOf(outcome, undefined)).toEqual([]);
  });

  it("names the workspace whose build limits refuse a tool, a model or a missing one", () => {
    const workspace = { workspaceId: "cws_kai", workspace: "Kai Spezis" };
    const messages = [
      { reason: "tool_not_allowed", toolName: "documents.read", ...workspace },
      { reason: "model_not_allowed", modelBindingId: "reasoning", ...workspace },
      { reason: "model_binding_required", ...workspace }
    ].map((details) => readBuildRefusal(refusal("FORBIDDEN", "Forbidden", details), t));
    const refused = (refusals: unknown[]) => ({ ok: false, conflict: false, refusals });
    expect(messages).toEqual([
      refused([
        {
          field: "tools",
          message:
            "The tool documents.read is not allowed in the workspace Kai Spezis. An instance admin sets its tools on Instance > Workspaces."
        }
      ]),
      refused([
        {
          field: "model",
          message:
            "The model reasoning is not allowed in the workspace Kai Spezis. An instance admin sets its models on Instance > Workspaces."
        }
      ]),
      refused([
        {
          field: "model",
          message:
            "An agent of the workspace Kai Spezis needs a default model the workspace allows."
        }
      ])
    ]);
  });

  it("tells a refusal from a workspace's build limits in the reader's language", () => {
    const outcome = readBuildRefusal(
      refusal("FORBIDDEN", "Forbidden", {
        reason: "tool_not_allowed",
        toolName: "documents.read",
        workspaceId: "ws-tax",
        workspace: "Steuern"
      }),
      createTranslationContext("de").t
    );

    expect(refusalsOf(outcome, "tools")).toEqual([
      "Das Werkzeug documents.read ist im Arbeitsbereich Steuern nicht erlaubt. Seine Werkzeuge legt ein Instanz-Admin unter Instanz > Arbeitsbereiche fest."
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
            "This change waits for an approval. Nothing was changed yet and your text is still here.",
          waiting: true
        }
      ]
    });
  });

  // ACCEPT-FIX-9 E6: the notice named nobody. It names who may approve, as the request lists
  // them, joined by "or" in the reader's language.
  it("names who may approve a change that waits, in both languages", () => {
    const waiting = new PendingApprovalError(["Mara Lindqvist", "Jonas Berg"]);

    expect(refusalsOf(readBuildRefusal(waiting, t), undefined)).toEqual([
      "This change waits for approval by Mara Lindqvist or Jonas Berg. Nothing has changed yet and your text is still here."
    ]);
    expect(
      refusalsOf(readBuildRefusal(waiting, createTranslationContext("de").t, "de"), undefined)
    ).toEqual([
      "Diese Änderung wartet auf Freigabe durch Mara Lindqvist oder Jonas Berg. Es wurde noch nichts geändert und dein Text ist noch da."
    ]);
    // The names come from the waiting request's preview; anything else there is left out.
    expect(approverNamesOf({ approverNames: ["Mara Lindqvist", 7, " ", "Jonas Berg"] })).toEqual([
      "Mara Lindqvist",
      "Jonas Berg"
    ]);
    expect(approverNamesOf(undefined)).toEqual([]);
  });

  it("shows every other sentence as the instance said it", () => {
    const unread = "The change would break an asset the caller may not read";

    expect(readBuildRefusal(refusal("VALIDATION_FAILED", unread), t)).toEqual({
      ok: false,
      conflict: false,
      refusals: [{ message: unread, asSent: true }]
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
