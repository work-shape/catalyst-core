// @vitest-environment happy-dom

import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { createApiClient, type OwnUsage, type UsageLimits } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  createTranslationContext,
  LimitsPage,
  OwnUsagePage,
  usageLimitBlockReason,
  usageNearNote,
  workspaceSendBlock
} from "./support/chat-ui";
import {
  mountPage,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  waitForText
} from "./chat-ui-settings-fixtures";

// The spend limits in the interface (LU-2, limits spec 3.1): the composer's sentence at a
// reached limit and its note at 80 percent, You > Usage and Settings > Instance > Limits.

const en = createTranslationContext("en");
const de = createTranslationContext("de");
const resets = { day: "2026-10-25T00:00:00.000Z", month: "2026-11-01T00:00:00.000Z" };

function usage(overrides: Partial<OwnUsage> = {}): OwnUsage {
  return {
    currency: "EUR",
    own: {
      day: { spent: 1, limit: 10, reached: false, resetsAt: resets.day },
      month: { spent: 5, resetsAt: resets.month }
    },
    instance: {
      day: { resetsAt: resets.day },
      month: { reached: false, resetsAt: resets.month }
    },
    ...overrides
  };
}

describe("the composer at a spend limit", () => {
  it("names the person's own limit with their amounts and when it resets", () => {
    const reached = usage({
      own: {
        day: { spent: 10, limit: 10, reached: true, resetsAt: resets.day },
        month: { spent: 5, resetsAt: resets.month }
      }
    });
    expect(usageLimitBlockReason(reached, en)).toBe(
      "You have reached your daily spend limit (€10.00 of €10.00). It resets at midnight UTC. An administrator can raise it."
    );
    expect(usageLimitBlockReason(reached, de)).toBe(
      "Du hast dein tägliches Ausgabenlimit erreicht (10,00\u00a0€ von 10,00\u00a0€). Es wird um Mitternacht UTC zurückgesetzt. Ein Administrator kann es erhöhen."
    );
  });

  it("gives a member no amount of the workspace and its owner the amounts", () => {
    const member = usage({
      workspace: {
        id: "cw_team",
        day: { resetsAt: resets.day },
        month: { reached: true, resetsAt: resets.month }
      }
    });
    expect(usageLimitBlockReason(member, en)).toBe(
      "This workspace has reached its monthly spend limit. It resets at the start of next month (UTC). An administrator can raise it; other workspaces keep working."
    );
    const owner = usage({
      workspace: {
        id: "cw_team",
        day: { resetsAt: resets.day },
        month: { spent: 200, limit: 200, reached: true, resetsAt: resets.month }
      }
    });
    expect(usageLimitBlockReason(owner, en)).toContain("(€200.00 of €200.00)");
  });

  it("names the instance's limit without an amount", () => {
    const stopped = usage({
      instance: {
        day: { reached: true, resetsAt: resets.day },
        month: { resetsAt: resets.month }
      }
    });
    expect(usageLimitBlockReason(stopped, en)).toBe(
      "This instance has reached its daily spend limit. It resets at midnight UTC. An administrator can raise it."
    );
    expect(usageLimitBlockReason(usage(), en)).toBeUndefined();
    expect(usageLimitBlockReason(undefined, en)).toBeUndefined();
  });

  it("closes the composer with the sentence, which a queued send does not wait for", () => {
    const reason = "This instance has reached its daily spend limit.";
    expect(
      workspaceSendBlock({
        attachmentBlockedReason: undefined,
        selectedConversationId: "conv_1",
        collaborationWorkspacesAvailable: true,
        activeCollaborationWorkspaceId: "cw_team",
        loading: false,
        loadFailed: false,
        workspacesListed: true,
        locale: "en",
        usageLimitReason: reason
      })
    ).toEqual({ reason, loading: false });
  });

  it("says how much is left from 80 percent of the person's own limit on, once per period", () => {
    const near = usage({
      own: {
        day: { spent: 8.5, limit: 10, reached: false, resetsAt: resets.day },
        month: { spent: 9, resetsAt: resets.month }
      }
    });
    expect(usageNearNote(near, en)).toEqual({
      key: `day:${resets.day}`,
      text: "€1.50 left of your daily spend limit."
    });
    expect(usageNearNote(near, de)?.text).toBe(
      "Von deinem täglichen Ausgabenlimit sind noch 1,50\u00a0€ übrig."
    );
    expect(usageNearNote(usage(), en)).toBeUndefined();
  });
});

function limits(overrides: Partial<UsageLimits> = {}): UsageLimits {
  return {
    currency: "EUR",
    ceiling: { daily: 50, monthly: 500 },
    effectiveInstance: { daily: 50, monthly: 500 },
    workspaces: [],
    users: [],
    nearLimit: [
      { kind: "user", id: "usr_kai", name: "Kai", period: "month", limit: 30, percent: 93 }
    ],
    workspaceOptions: [{ id: "cw_team", name: "Team" }],
    userOptions: [{ id: "usr_kai", name: "Kai" }],
    ...overrides
  };
}

function typeInto(field: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The limits page against a fetch that answers the read and records the changes. After a
 * change it reads `after`, as the instance would.
 */
async function openLimits(answerChange: () => Response, after: UsageLimits = limits()) {
  const changes: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === apiOperations["usage.limits.set"].method) {
      changes.push(await request.json());
      return answerChange();
    }
    return Response.json(changes.length === 0 ? limits() : after);
  };
  const mounted = await mountPage(
    settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl })),
    "en",
    createElement(LimitsPage)
  );
  await waitForText(mounted.container, "Every user");
  return { ...mounted, changes };
}

function editor(container: HTMLElement, label: string) {
  const found = container.querySelector<HTMLElement>(
    `[data-testid="limit-editor"][data-label="${label}"]`
  );
  if (!found) throw new Error(`No editor ${label}`);
  const [daily, monthly] = [...found.querySelectorAll<HTMLInputElement>("input")];
  const save = [...found.querySelectorAll("button")].find(
    (button) => button.textContent === "Save"
  );
  if (!daily || !monthly || !save) throw new Error(`Editor ${label} is incomplete`);
  return { element: found, daily, monthly, save };
}

describe("Settings > Instance > Limits", () => {
  it("shows the ceiling and who is near a limit, and saves a default for every user", async () => {
    const page = await openLimits(
      () => Response.json({ level: "user_default", limits: { monthly: 30 } }),
      limits({ userDefault: { monthly: 30 } })
    );
    try {
      expect(page.container.textContent).toContain(
        "The team that runs this instance allows at most €50.00 a day and €500.00 a month."
      );
      expect(page.container.textContent).toContain("93 % of the monthly limit of €30.00");
      const users = editor(page.container, "Every user");
      expect(users.save.disabled).toBe(true);
      await act(async () => typeInto(users.monthly, "30"));
      expect(users.save.disabled).toBe(false);
      await act(async () => users.save.click());
      await waitForText(page.container, "Saved. It applies from the next message.");
      expect(page.changes).toEqual([{ level: "user_default", limits: { monthly: 30 } }]);
    } finally {
      await page.unmount();
    }
  });

  it("says why an instance limit above the ceiling was refused", async () => {
    const page = await openLimits(() =>
      Response.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: "above",
            details: { reason: "above_ceiling", period: "monthly", ceiling: 500 }
          }
        },
        { status: 422 }
      )
    );
    try {
      const instance = editor(page.container, "Instance");
      await act(async () => typeInto(instance.monthly, "900"));
      await act(async () => instance.save.click());
      await waitForText(
        page.container,
        "This is above the most the team that runs this instance allows: €500.00."
      );
      expect(page.changes).toEqual([{ level: "instance", limits: { monthly: 900 } }]);
    } finally {
      await page.unmount();
    }
  });
});

describe("You > Usage", () => {
  it("shows the person's own spending against their limit", async () => {
    const fetchImpl: typeof fetch = async () => Response.json(usage());
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl })),
      "de",
      createElement(OwnUsagePage)
    );
    try {
      await waitForText(mounted.container, "1,00\u00a0€ von 10,00\u00a0€");
      expect(mounted.container.textContent).toContain("5,00\u00a0€, kein Limit");
    } finally {
      await mounted.unmount();
    }
  });
});
