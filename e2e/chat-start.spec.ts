import type { Page, Route } from "@playwright/test";
import { z } from "zod";
import { reviewer, signIn } from "./inbox-fixtures";
import { shootEverywhere } from "./surface-shots";
import { expect, test } from "./test";

// The chat start offers one style of suggestion: the prompts the agent's author wrote and the
// starters of its skills stand as the same cards in one list, each with an icon on the same
// tile, four at most. A member sees the composer's model control only where the agent's author
// offered a choice; a writer of the agent sees it as before (UXA-7c, UX audit ruling 4,
// navigation check 42). Fails without the change: the author's prompts stood as pills of their
// own under the cards. Which choice the instance offers whom, and the cap of four, are decided
// on the server and held by `tests/agent-model-choice.test.ts` and `tests/skill-starters.test.ts`;
// the suite's instance has one model with a fixed effort and no starters, so this spec gives
// the default agent what the server answers for each case.

/** A member who may write no agent. No other spec uses this member. */
const member = { email: "e2e-chat-start@example.test", password: "e2e-chat-start-password" };

const SUGGESTIONS = /^(?:Suggestions to start with|Vorschläge für den Einstieg)$/u;
const SELECT_MODEL = /^(?:Select model|Modell auswählen)$/u;

/** What the default agent offers on the start page here, in the language of the request. */
function startersIn(locale: "en" | "de", full: boolean) {
  const de = locale === "de";
  const skillStarters = [
    de
      ? {
          title: "Tabelle anlegen",
          hint: "Mit Formeln, die rechnen",
          prompt: "Lege eine Tabelle an."
        }
      : { title: "Build a sheet", hint: "With formulas that calculate", prompt: "Build a sheet." },
    de
      ? { title: "Formel erklären", hint: "Schritt für Schritt", prompt: "Erkläre die Formel." }
      : { title: "Explain a formula", hint: "Step by step", prompt: "Explain the formula." }
  ].map((starter) => ({ skillName: "spreadsheets", icon: "spreadsheet", ...starter }));
  return {
    // With four starters of its skills and two prompts of its author, the server answers the
    // author's two and the first two of the skills'.
    starters: full ? skillStarters : skillStarters.slice(0, 1),
    initialPrompts: de
      ? [
          {
            title: "Prüfrisiken finden",
            prompt: "Nenne die wichtigsten Risiken, die ich zuerst prüfen sollte."
          },
          { title: "Rückfragen entwerfen", prompt: "Rückfragen entwerfen" }
        ]
      : [
          {
            title: "Find review risks",
            prompt: "List the most important review risks I should check first."
          },
          { title: "Draft questions", prompt: "Draft questions" }
        ]
  };
}

const agentSchema = z.looseObject({
  name: z.string(),
  selectableModels: z.array(z.looseObject({}))
});
const listsSchema = z.looseObject({
  defaultAgentName: z.string().optional(),
  agents: z.array(z.unknown()).optional(),
  items: z.array(z.unknown()).optional()
});

/** What the default agent's models offer the signed-in person. */
type Offer = "none" | "second-model" | "writer-efforts";

/**
 * Answers the agent lists of the page with the default agent given starters and prompts and
 * the models `offer` names, as an instance would answer for that case.
 */
async function offerStarters(
  page: Page,
  { offer, full = false }: { offer: Offer; full?: boolean }
): Promise<void> {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route(/\/api\/v1\/(?:instance\/config|.*agents)(?:\?|$)/u, async (route: Route) => {
    if (route.request().method() !== "GET") {
      return route.fallback();
    }
    const url = new URL(route.request().url());
    const requested =
      url.searchParams.get("locale") ?? route.request().headers()["accept-language"];
    const locale = requested?.startsWith("de") ? "de" : "en";
    const response = await route.fetch();
    const body = listsSchema.safeParse(await response.json().catch(() => undefined));
    if (!body.success) {
      return route.fulfill({ response });
    }
    const models = (own: unknown) => {
      if (offer === "second-model") {
        return [
          own,
          {
            bindingId: "e2e-chat-start-second",
            model: "e2e-second-model",
            label: "E2E second model",
            selectableReasoningEfforts: []
          }
        ];
      }
      if (offer === "writer-efforts") {
        // The author set the effort; a writer of the agent is offered what the binding allows.
        return [
          {
            ...z.looseObject({}).parse(own),
            reasoningEffort: "high",
            selectableReasoningEfforts: ["low", "high"]
          }
        ];
      }
      return [own];
    };
    const withStarters = (agent: unknown) => {
      const parsed = agentSchema.safeParse(agent);
      if (!parsed.success || parsed.data.name !== body.data.defaultAgentName) {
        return agent;
      }
      return {
        ...parsed.data,
        ...startersIn(locale, full),
        selectableModels: models(parsed.data.selectableModels[0])
      };
    };
    return route.fulfill({
      response,
      json: {
        ...body.data,
        ...(body.data.agents ? { agents: body.data.agents.map(withStarters) } : {}),
        ...(body.data.items ? { items: body.data.items.map(withStarters) } : {})
      }
    });
  });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("the chat start offers one style of suggestion, and the model control only as a choice", async ({
  page
}) => {
  test.setTimeout(process.env.E2E_SHOTS_DIR ? 600_000 : 60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, member);
  await offerStarters(page, { offer: "none" });
  await page.reload();

  const chat = page.getByRole("region", { name: "Chat" });
  const suggestions = chat.getByRole("group", { name: SUGGESTIONS });
  const cards = suggestions.getByRole("button");
  const readyWith = (count: number) => async () => {
    await expect(cards).toHaveCount(count);
    // A picture shows the cards at rest, not under the pointer.
    await page.mouse.move(0, 0);
  };
  const ready = readyWith(3);
  await ready();
  // The author's prompts first, then the skill's starter, each a card of the same kind.
  await expect(cards.nth(0)).toContainText("Find review risks");
  await expect(cards.nth(0)).toContainText(
    "List the most important review risks I should check first."
  );
  await expect(cards.nth(1)).toHaveAccessibleName("Draft questions");
  await expect(cards.nth(2)).toContainText("Build a sheet");
  const looks = await cards.evaluateAll((buttons) =>
    buttons.map((button) => {
      const style = getComputedStyle(button);
      return `${button.className}|${style.borderRadius}|${style.borderTopWidth}`;
    })
  );
  expect(new Set(looks).size).toBe(1);
  // Every card leads with an icon of the same size, so every title starts at the same edge,
  // and a card without a hint stands as high as the others.
  const shapes = await cards.evaluateAll((buttons) =>
    buttons.map((button) => {
      const icon = button.querySelector("[data-skill-icon]")?.getBoundingClientRect();
      const title = button.querySelector(".text-label")?.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return {
        icon: icon ? `${Math.round(icon.width)}x${Math.round(icon.height)}` : "none",
        titleEdge: title ? Math.round(title.left - box.left) : -1,
        height: Math.round(box.height)
      };
    })
  );
  expect(new Set(shapes.map((shape) => shape.icon))).toEqual(new Set(["32x32"]));
  expect(new Set(shapes.map((shape) => shape.titleEdge)).size).toBe(1);
  expect(new Set(shapes.map((shape) => shape.height)).size).toBe(1);
  // No suggestion stands outside the list.
  await expect(chat.getByRole("button", { name: "Draft questions" })).toHaveCount(1);
  // The author offered one model with a fixed effort: the member is shown no model control.
  await expect(chat.getByRole("button", { name: SELECT_MODEL })).toHaveCount(0);

  // A chosen starter fills the composer and sends nothing.
  await cards.nth(0).click();
  await expect(chat.getByRole("textbox", { name: "Message" })).toHaveValue(
    "List the most important review risks I should check first."
  );
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await shootEverywhere(page, "uxa-7c-start-member", ready);

  // An agent whose skills offer four starters beside two prompts of its author: four cards.
  await offerStarters(page, { offer: "none", full: true });
  await page.reload();
  await readyWith(4)();
  await expect(cards.nth(0)).toContainText("Find review risks");
  await expect(cards.nth(3)).toContainText("Explain a formula");
  await shootEverywhere(page, "uxa-7c-start-member-full", readyWith(4));

  // Where the author offered a second model, the member is shown the control.
  await offerStarters(page, { offer: "second-model" });
  await page.reload();
  await ready();
  await expect(chat.getByRole("button", { name: SELECT_MODEL })).toBeVisible();
  await shootEverywhere(page, "uxa-7c-start-member-choice", async () => {
    await ready();
    await expect(chat.getByRole("button", { name: SELECT_MODEL })).toBeVisible();
  });
});

test("a writer of the agent is shown the model control as before", async ({ page }) => {
  test.setTimeout(process.env.E2E_SHOTS_DIR ? 300_000 : 60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, reviewer);
  await offerStarters(page, { offer: "writer-efforts" });
  await page.reload();

  const chat = page.getByRole("region", { name: "Chat" });
  const ready = async () => {
    await expect(chat.getByRole("group", { name: SUGGESTIONS }).getByRole("button")).toHaveCount(3);
    await expect(chat.getByRole("button", { name: SELECT_MODEL })).toBeVisible();
    await page.mouse.move(0, 0);
  };
  await ready();
  await shootEverywhere(page, "uxa-7c-start-writer", ready);
});
