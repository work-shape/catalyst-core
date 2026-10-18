import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  RightsLacking,
  createInstanceSource,
  giveFailureSentence,
  workflowPublishRefusal,
  type WorkflowPublishRightsView
} from "@work-shape/catalyst-chat-ui/workflows";
import { ACTIONS } from "@work-shape/catalyst-core";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// The question before a Workflow is published names, in the reader's words, the rights its
// technical accounts lack, and offers the one step that gives them to whoever may.

const render = (node: ReactNode, locale: "en" | "de") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const rightId = new RegExp(
  `(?<![\\w.])(${ACTIONS.map((a) => a.replace(/\./gu, "\\.")).join("|")})(?![\\w])`,
  "u"
);
const never = () => Promise.resolve();

const lacking = (administers: boolean): WorkflowPublishRightsView => ({
  administers,
  hiddenWorkflows: 0,
  workflows: [
    {
      workflow: "parent",
      revision: "draft",
      runAs: "workflow-runner",
      account: { label: "Workflow runner", status: "active" },
      rights: [
        {
          action: "workflow.use",
          asset: { kind: "workflow", name: "child" },
          steps: ["child"],
          neededFor: "publish",
          held: false,
          ...(administers
            ? { grant: { holderId: "sp_secret_id", scopeId: "asset_secret_id" } }
            : { refusal: "not_administrator" as const })
        }
      ]
    },
    {
      workflow: "child",
      revision: "published",
      runAs: "workflow-runner",
      account: { label: "Workflow runner", status: "active" },
      rights: [
        {
          action: "connection.use",
          asset: { kind: "connection", name: "exampledata" },
          steps: ["read"],
          neededFor: "run",
          held: false,
          refusal: administers ? ("not_held" as const) : ("not_administrator" as const)
        },
        {
          action: "data_store.insert",
          asset: { kind: "data_store", name: "mandanten" },
          steps: ["store"],
          neededFor: "run",
          held: true
        }
      ]
    }
  ]
});

describe("the rights the technical accounts of a publish lack", () => {
  it("names each right in the verb table's words on its resource, in both languages", () => {
    const en = render(
      createElement(RightsLacking, { view: lacking(true), give: never, onGiven: never }),
      "en"
    );
    expect(en).toContain("Use workflows: Workflow child");
    expect(en).toContain("Use connections: Connection exampledata");
    expect(en).toContain("Needed to publish");
    expect(en).toContain("Needed when it runs");
    expect(en).toContain("You do not hold this right here yourself");
    expect(en).toContain("Give 1 right");
    expect(en).not.toContain("Add rows to data stores");
    const de = render(
      createElement(RightsLacking, { view: lacking(true), give: never, onGiven: never }),
      "de"
    );
    expect(de).toContain("Workflows verwenden: Workflow child");
    expect(de).toContain("Verbindungen verwenden: Verbindung exampledata");
    expect(de).toContain("Nötig zum Veröffentlichen");
    expect(de).toContain("Unter-Workflow child läuft als Workflow runner");
    expect(de).toContain("1 Recht geben");
    for (const markup of [en, de]) {
      expect(markup).not.toMatch(rightId);
      expect(markup).not.toContain("sp_secret_id");
      expect(markup).not.toContain("asset_secret_id");
    }
    expect(de).not.toMatch(/Principal/u);
  });

  it("tells a reader who administers no account who can give the rights, and offers no step", () => {
    for (const locale of ["en", "de"] as const) {
      const markup = render(
        createElement(RightsLacking, { view: lacking(false), give: never, onGiven: never }),
        locale
      );
      expect(markup).toContain(
        locale === "en"
          ? "Only someone who administers technical accounts"
          : "Technische Konten verwaltet"
      );
      expect(markup).not.toContain('data-testid="workflow-publish-rights-give"');
    }
  });

  it("counts the child Workflows the reader cannot see and names no resource it cannot see", () => {
    const view: WorkflowPublishRightsView = {
      administers: false,
      hiddenWorkflows: 2,
      workflows: [
        {
          workflow: "parent",
          revision: "draft",
          runAs: "workflow-runner",
          account: { label: "Workflow runner", status: "active" },
          rights: [
            {
              action: "workflow.use",
              asset: { kind: "workflow" },
              steps: ["first"],
              neededFor: "publish",
              held: false,
              refusal: "not_visible"
            }
          ]
        }
      ]
    };
    const en = render(createElement(RightsLacking, { view, give: never, onGiven: never }), "en");
    expect(en).toContain("Use workflows: a resource you cannot see");
    expect(en).toContain("You cannot see this resource, so you cannot give this right.");
    expect(en).toContain("2 child workflows you cannot see need rights. Ask an admin.");
    const de = render(
      createElement(RightsLacking, {
        view: { ...view, hiddenWorkflows: 1 },
        give: never,
        onGiven: never
      }),
      "de"
    );
    expect(de).toContain("Workflows verwenden: eine Ressource, die du nicht sehen kannst");
    expect(de).toContain("Ein Unter-Workflow, den du nicht sehen kannst, braucht Rechte.");
    // A hidden child alone still says something is missing, never that all is held.
    const only = render(
      createElement(RightsLacking, {
        view: { administers: false, hiddenWorkflows: 1, workflows: [] },
        give: never,
        onGiven: never
      }),
      "en"
    );
    expect(only).toContain("A child workflow you cannot see needs rights.");
    expect(only).not.toContain("hold every right");
  });

  it("says so where every right is held", () => {
    const held: WorkflowPublishRightsView = {
      administers: true,
      hiddenWorkflows: 0,
      workflows: lacking(true).workflows.map((entry) => ({
        ...entry,
        rights: entry.rights.map((right) => ({ ...right, held: true }))
      }))
    };
    expect(
      render(createElement(RightsLacking, { view: held, give: never, onGiven: never }), "de")
    ).toContain("Die Technischen Konten haben jedes Recht");
  });
});

describe("a refused publish of a Workflow", () => {
  const refusal = (code: string, details: Record<string, string>) =>
    new ApiError(code === "FORBIDDEN" ? 403 : 400, "refused", {
      error: {
        code,
        message: "The parent's principal does not hold workflow.use on the child",
        details
      }
    });
  const en = createTranslationContext("en").t;
  const de = createTranslationContext("de").t;

  it("is said in the reader's language instead of the instance's reason", () => {
    const childUse = refusal("FORBIDDEN", {
      reason: "child_use_forbidden",
      action: "workflow.use",
      workflow: "child"
    });
    expect(workflowPublishRefusal(childUse, en)).toBe(
      "The technical account of this workflow may not use the child workflow child. Give it that right, then publish again."
    );
    expect(workflowPublishRefusal(childUse, de)).toBe(
      "Das Technische Konto dieses Workflows darf den Unter-Workflow child nicht verwenden. Gib ihm dieses Recht und veröffentliche dann erneut."
    );
    expect(
      workflowPublishRefusal(
        refusal("VALIDATION_FAILED", { reason: "no_parent_trigger", workflow: "child" }),
        de
      )
    ).toContain("Der Unter-Workflow child kann nicht von einem anderen Workflow gestartet werden");
    expect(
      workflowPublishRefusal(
        refusal("VALIDATION_FAILED", { reason: "run_as_unknown", runAs: "runner" }),
        en
      )
    ).toBe(
      "This workflow runs as the technical account “runner”, which does not exist. Choose an active account in the workflow. An administrator manages the accounts under Settings › API access."
    );
    expect(
      workflowPublishRefusal(
        refusal("FORBIDDEN", { reason: "no_grant", action: "connection.use" }),
        de
      )
    ).toContain("Dir fehlt: Verbindungen verwenden.");
    for (const reason of [
      "child_use_forbidden",
      "no_parent_trigger",
      "child_unpublished",
      "workflow_cycle",
      "run_as_missing",
      "run_as_disabled",
      "user_only"
    ])
      for (const t of [en, de]) {
        const sentence = workflowPublishRefusal(refusal("VALIDATION_FAILED", { reason }), t) ?? "";
        expect(sentence, reason).not.toBe("");
        expect(sentence, reason).not.toMatch(rightId);
        expect(sentence, reason).not.toContain(reason);
      }
    // A right on a resource the reader may not see is refused at the grant, and said so.
    const hidden = refusal("FORBIDDEN", { reason: "not_visible", action: "connection.read" });
    expect(giveFailureSentence(hidden, de)).toBe(
      "Du kannst diese Ressource nicht sehen und dieses Recht deshalb nicht geben. Bitte einen Admin darum."
    );
    expect(giveFailureSentence(new Error("offline"), en)).toBe(
      "This right could not be given. Try again."
    );
    // A refusal the page has no sentence for is said as the instance said it.
    expect(
      workflowPublishRefusal(
        refusal("FORBIDDEN", { reason: "no_grant", action: "workflow.publish" }),
        en
      )
    ).toBeUndefined();
  });
});

describe("the instance's source of the rights of a publish", () => {
  it("reads the Workflow's needs and gives each right through the ordinary grant write", async () => {
    const { client, calls } = recordedApiClient(({ operation }) =>
      operation === "workflows.principal_rights"
        ? lacking(true)
        : {
            id: "grant_1",
            holderKind: "service_principal",
            holderId: "sp_1",
            action: "workflow.use",
            effect: "allow",
            scopeKind: "asset",
            scopeId: "asset_1",
            createdAt: "2026-10-18T10:00:00.000Z"
          }
    );
    const source = createInstanceSource(client, "test").publishRights;
    expect(await source?.read("parent", new AbortController().signal)).toEqual(lacking(true));
    await source?.give({ holderId: "sp_1", action: "workflow.use", scopeId: "asset_1" });
    expect(
      calls.map((call) => [
        call.operation,
        call.params,
        call.body ? JSON.parse(call.body) : undefined
      ])
    ).toEqual([
      ["workflows.principal_rights", { workflow: "parent" }, undefined],
      [
        "permissions.grant",
        {},
        {
          holderKind: "service_principal",
          holderId: "sp_1",
          action: "workflow.use",
          effect: "allow",
          scopeKind: "asset",
          scopeId: "asset_1"
        }
      ]
    ]);
  });
});
