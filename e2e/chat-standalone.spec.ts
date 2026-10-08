import { randomUUID } from "node:crypto";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type Locator, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const normalUser = {
  email: "e2e-user@example.test",
  password: "e2e-user-password"
};
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const adminUser = {
  email: "e2e-admin@example.test",
  password: "e2e-admin-password"
};

test("standalone login renders the authenticated chat workspace", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue("");
  await expect(page.getByLabel("Password")).toHaveValue("");
  await page.getByLabel("Email").fill(normalUser.email);
  await page.getByLabel("Password").fill(normalUser.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page.getByText("E2E Customer")).toBeVisible();
  await expect(page.getByText("E2E User")).toBeVisible();
  await expect(page.getByRole("button", { name: "E2E User account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select agent" })).toContainText(
    "Application Assistant"
  );
  await expect(page.getByRole("button", { name: "Close sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Switch to (dark|light) theme/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Language" })).toHaveCount(0);
  await expect(page.locator("header").getByText("Ready", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open administration panel" })).toHaveCount(0);

  await page.getByRole("button", { name: "E2E User account" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "User settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Language" })).toBeVisible();
});

test("floating chrome toggles sidebar, agent, and theme", async ({ page }) => {
  await signInViaApi(page, normalUser);
  const conversationTitle = `Floating chrome ${Date.now()}`;
  await createListedConversation(page, conversationTitle);
  await page.goto("/");

  const conversationRail = page.getByRole("complementary", { name: "Conversations" });
  await page.getByRole("button", { name: "Close sidebar" }).click();
  await expect(conversationRail).toBeHidden();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(conversationRail).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
  // The collapse handle shows, and takes the pointer, only while the pointer is on the rail's
  // right border.
  const collapseHandle = page.getByRole("button", { name: "Collapse sidebar" });
  const collapseHandleBox = await collapseHandle.boundingBox();
  if (!collapseHandleBox) throw new Error("collapse handle is not laid out");
  await page.mouse.move(
    collapseHandleBox.x + collapseHandleBox.width / 2,
    collapseHandleBox.y + collapseHandleBox.height / 2
  );
  await expect(collapseHandle).toHaveCSS("opacity", "1");
  await collapseHandle.click();
  await expect(conversationRail).toBeHidden();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(conversationRail).toBeVisible();

  // The floating chrome names the agent once a conversation is open; on the start page the
  // heading carries it instead.
  const agentSelector = page.locator("header").getByRole("button", { name: "Select agent" });
  await expect(
    page.getByRole("region", { name: "Chat" }).getByRole("button", { name: "Select agent" })
  ).toContainText("Application Assistant");
  await expect(agentSelector).toHaveCount(0);
  await page
    .getByTestId("conversation-row")
    .filter({ hasText: conversationTitle })
    .getByRole("button")
    .first()
    .click();
  await expect(agentSelector).toContainText("Application Assistant");
  await expect(agentSelector.locator("svg").first()).toBeVisible();
  await agentSelector.click();
  await expect(page.getByRole("option", { name: /Application Assistant/ })).toContainText(
    "Help with application and document review."
  );
  await expect(page.getByRole("listbox")).not.toContainText("application_assistant");
  await expect(page.getByRole("option", { name: /Research Assistant/ })).toHaveText(
    "Research Assistant"
  );
  await expect(page.getByRole("option", { name: /Research Assistant/ })).toBeVisible();
  await page.getByRole("option", { name: /Research Assistant/ }).click();
  await expect(agentSelector).toContainText("Research Assistant");

  await page.getByRole("button", { name: "Close sidebar" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(agentSelector).toBeVisible();
  await expect(agentSelector.locator("svg").first()).toBeVisible();
  await expect(agentSelector).toHaveAccessibleName("Select agent: Research Assistant");
  await expect(agentSelector).toHaveAttribute("title", "Research Assistant");
  // Screen-reader-only text has a box, so Playwright's visibility matcher alone would pass.
  // Check that the rendered name is clipped out while the icon remains visible.
  const agentName = agentSelector.getByText("Research Assistant", { exact: true }).locator("..");
  await expect(agentName).toHaveCSS("clip-path", "inset(50%)");
  await expect(agentName).toHaveCSS("width", "1px");
  await expect(agentName).toHaveCSS("height", "1px");
  await expect(agentName).toHaveCSS("overflow", "hidden");

  const appShell = page.locator("main").first();
  const backgroundBefore = await appShell.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--background")
  );
  await page.getByRole("button", { name: /Switch to (dark|light) theme/ }).click();
  await expect
    .poll(() =>
      appShell.evaluate((element) => getComputedStyle(element).getPropertyValue("--background"))
    )
    .not.toBe(backgroundBefore);
});

test("conversation rail keeps dense histories readable and scrollable", async ({ page }) => {
  await signInViaApi(page, normalUser);
  const titlePrefix = `Dense rail ${Date.now()}`;
  await Promise.all(
    Array.from({ length: 18 }, (_, index) =>
      createListedConversation(page, `${titlePrefix} item-${String(index + 1).padStart(2, "0")}`)
    )
  );

  await page.goto("/");
  const targetConversation = page
    .getByTestId("conversation-row")
    .filter({ hasText: `${titlePrefix} item-01` });
  await expect(targetConversation).toHaveCount(1);
  await expect
    .poll(() => targetConversation.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThanOrEqual(36);

  const conversationNavigation = page.getByRole("navigation");
  await expect(conversationNavigation).toBeVisible();
  const overflow = await conversationNavigation.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
});

test("composer grows for multiline input", async ({ page }) => {
  await signInViaUi(page, normalUser);
  await page.goto("/");

  const input = page.getByPlaceholder("Message");
  await expect(input).toBeVisible();
  const initialHeight = await input.evaluate((element) => element.getBoundingClientRect().height);

  await input.fill("Line one\nLine two\nLine three");

  await expect
    .poll(() => input.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(initialHeight);
});

test("start page centres the composer and settles it at the bottom after the first message", async ({
  page
}) => {
  await signInViaUi(page, normalUser);
  await page.goto("/");

  const chat = page.getByRole("region", { name: "Chat" });
  const input = page.getByPlaceholder("Message");
  await expect(input).toBeVisible();

  // Distance of the composer's centre from the centre of the chat area, and
  // the gap between the composer and the lower edge of the chat area.
  const composerPlacement = () =>
    chat.evaluate((region) => {
      const composer = region.querySelector("textarea")?.closest("form");
      if (!composer) throw new Error("composer not found");
      const regionBox = region.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      return {
        centreOffset: Math.abs(
          composerBox.top + composerBox.height / 2 - (regionBox.top + regionBox.height / 2)
        ),
        bottomGap: regionBox.bottom - composerBox.bottom,
        headingAbove:
          (region.querySelector("h2")?.getBoundingClientRect().bottom ?? Infinity) <=
          composerBox.top
      };
    });

  const start = await composerPlacement();
  expect(start.centreOffset).toBeLessThan(80);
  expect(start.bottomGap).toBeGreaterThan(150);
  expect(start.headingAbove).toBe(true);
  await expect(chat.locator('[data-slot="workspace-apps"]')).toHaveCount(1);
  await expect(chat.locator('[data-slot="workspace-apps"] > *')).toHaveCount(0);

  // The chip above the welcome message names the agent and is the picker; it lists one option
  // per agent. The header shows no agent while the start page does.
  const agentPicker = chat.getByRole("button", { name: "Select agent" });
  const agentListbox = chat.getByRole("listbox");
  const agentOptions = agentListbox.getByRole("option");
  const headerAgent = page.locator("header").getByRole("button", { name: "Select agent" });
  await input.fill("Draft that survives choosing an agent");
  await expect(agentPicker).toContainText("Application Assistant");
  await expect(headerAgent).toHaveCount(0);
  await agentPicker.click();
  await expect(agentListbox).toHaveAccessibleName("Select agent");
  await expect(agentOptions).toHaveCount(2);
  await expect(agentOptions.filter({ hasText: "Application Assistant" })).toContainText(
    "Help with application and document review."
  );
  await expect(agentOptions.filter({ hasText: "Application Assistant" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  await agentOptions.filter({ hasText: "Research Assistant" }).click();
  await expect(agentPicker).toContainText("Research Assistant");
  await expect(agentPicker).toBeFocused();
  await expect(chat.getByRole("button", { name: "Summarize policy" })).toBeVisible();
  await expect(chat.getByRole("button", { name: "Find review risks" })).toHaveCount(0);
  await agentPicker.focus();
  await page.keyboard.press("Enter");
  await expect(agentOptions.filter({ hasText: "Research Assistant" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await agentOptions.filter({ hasText: "Application Assistant" }).focus();
  await page.keyboard.press("Escape");
  await expect(agentListbox).toHaveCount(0);
  await expect(agentPicker).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(agentListbox).toHaveAccessibleName("Select agent");
  await agentOptions.filter({ hasText: "Application Assistant" }).focus();
  await page.keyboard.press("Enter");
  await expect(agentListbox).toHaveCount(0);
  await expect(agentPicker).toBeFocused();
  await expect(chat.getByRole("button", { name: "Find review risks" })).toBeVisible();
  await expect(input).toHaveValue("Draft that survives choosing an agent");

  await input.press("Enter");
  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
  await expect(agentPicker).toHaveCount(0);
  await expect(headerAgent).toContainText("Application Assistant");
  await expect(headerAgent.locator("svg").first()).toBeVisible();
  await expect(chat.locator('[data-slot="workspace-apps"]')).toHaveCount(0);
  await expect(chat.getByText("Draft that survives choosing an agent")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect.poll(async () => (await composerPlacement()).bottomGap).toBeLessThan(40);
});

test("the agent chip flies from the start page into the header once", async ({ page }) => {
  const headerAnimations = await recordHeaderAnimations(page, true);
  await signInViaUi(page, normalUser);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);

  let releaseCreateRun = () => {};
  const createRunGate = new Promise<void>((resolve) => {
    releaseCreateRun = resolve;
  });
  await page.route(`${apiBaseUrl}/api/conversations/runs`, async (route) => {
    if (route.request().method() === "POST") {
      await createRunGate;
    }
    await route.continue();
  });

  const chat = page.getByRole("region", { name: "Chat" });
  const header = page.locator("header");
  const startChip = chat.getByRole("button", { name: "Select agent" });
  const headerChip = header.getByRole("button", { name: "Select agent" });
  const heading = chat.getByRole("heading", { name: "E2E ready." });
  const composer = chat.locator("form").filter({ has: page.getByPlaceholder("Message") });
  const startName = startChip.locator("[data-agent-chip-name]");
  const headerName = headerChip.locator("[data-agent-chip-name]");
  const messageText = `Agent chip flight ${Date.now()}`;

  await expect(startChip).toContainText("Application Assistant");
  await expect(headerChip).toHaveCount(0);
  await expect(startName).toHaveCSS("font-weight", "600");
  const startNameColor = await startName.evaluate((name) => getComputedStyle(name).color);
  const startChipBox = await startChip.boundingBox();
  const headingBox = await heading.boundingBox();
  const composerBox = await composer.boundingBox();
  if (!startChipBox) throw new Error("start page agent chip is not laid out");

  await page.getByPlaceholder("Message").fill(messageText);
  await page.getByRole("button", { name: "Send message" }).click();

  // The chip leaves with the click, before the server has answered, and nothing else moves.
  await expect(headerChip).toContainText("Application Assistant");
  await expect(startChip).toHaveCount(0);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  expect(await heading.boundingBox()).toEqual(headingBox);
  expect(await composer.boundingBox()).toEqual(composerBox);
  // The chip's movement and its name's colour.
  expect(await headerAnimations()).toHaveLength(2);
  await headerChip.evaluate((chip) => chip.setAttribute("data-flown", "true"));

  // Inspect the real Web Animation, paused by the recorder before it can finish.
  const flight = await headerChip.evaluate((chip) => {
    const header = chip.closest("header");
    const [animation] = (header?.getAnimations({ subtree: true }) ?? []).filter(
      ({ effect }) =>
        effect instanceof KeyframeEffect &&
        effect.target instanceof Element &&
        effect.target !== header &&
        effect.target.contains(chip)
    );
    const effect = animation?.effect;
    if (
      !animation ||
      !(effect instanceof KeyframeEffect) ||
      !(effect.target instanceof Element) ||
      !effect.target.contains(chip)
    ) {
      throw new Error("header agent chip flight not found");
    }
    const duration = effect.getTiming().duration;
    if (typeof duration !== "number") throw new Error("chip flight duration is not numeric");
    const keyframes = effect.getKeyframes();
    const position = () => {
      const { x, y } = chip.getBoundingClientRect();
      return { x, y };
    };
    animation.pause();
    animation.currentTime = 0;
    const origin = position();
    animation.currentTime = duration;
    const destination = position();
    animation.currentTime = duration / 2;
    return {
      duration,
      firstTransform: String(keyframes[0]?.transform ?? ""),
      lastTransform: String(keyframes.at(-1)?.transform ?? ""),
      origin,
      destination,
      midpoint: position()
    };
  });
  expect(flight.duration).toBeGreaterThanOrEqual(300);
  expect(flight.duration).toBeLessThanOrEqual(400);
  expect(flight.lastTransform).toBe("none");
  const [fromX, fromY] = (/translate\((.+)px, (.+)px\)/u.exec(flight.firstTransform) ?? []).slice(
    1
  );
  expect(Number(fromX)).toBeCloseTo(startChipBox.x - flight.destination.x, 0);
  expect(Number(fromY)).toBeCloseTo(startChipBox.y - flight.destination.y, 0);
  expect(flight.origin.x).toBeCloseTo(startChipBox.x, 0);
  expect(flight.origin.y).toBeCloseTo(startChipBox.y, 0);
  expect(flight.destination.y).toBeLessThan(startChipBox.y);
  for (const axis of ["x", "y"] as const) {
    expect(flight.midpoint[axis]).toBeGreaterThan(
      Math.min(flight.origin[axis], flight.destination[axis])
    );
    expect(flight.midpoint[axis]).toBeLessThan(
      Math.max(flight.origin[axis], flight.destination[axis])
    );
  }

  // On the way the name's colour eases from the start page's to the header's quieter one,
  // which the picker's chevron already has.
  const mutedColor = await headerChip
    .locator("svg")
    .last()
    .evaluate((chevron) => getComputedStyle(chevron).color);
  const nameColor = await headerName.evaluate((name) => {
    const [animation] = name.getAnimations();
    const duration = animation?.effect?.getTiming().duration;
    if (!animation || typeof duration !== "number") {
      throw new Error("agent name colour animation not found");
    }
    const at = (time: number) => {
      animation.currentTime = time;
      return getComputedStyle(name).color;
    };
    animation.pause();
    return { duration, start: at(0), end: at(duration), midpoint: at(duration / 2) };
  });
  expect(nameColor.duration).toBe(flight.duration);
  expect(nameColor.start).toBe(startNameColor);
  expect(nameColor.end).toBe(mutedColor);
  expect(mutedColor).not.toBe(startNameColor);
  expect([nameColor.start, nameColor.end]).not.toContain(nameColor.midpoint);
  // Its weight is the header's lighter one from the first frame.
  await expect(headerName).toHaveCSS("font-weight", "500");

  await expect(headerChip).toBeVisible();
  await header.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      if (animation.playState === "paused") animation.play();
    }
  });
  await expect
    .poll(() => header.evaluate((element) => element.getAnimations({ subtree: true }).length))
    .toBe(0);
  await expect(headerName).toHaveCSS("color", mutedColor);

  // The route change keeps the chip that flew in instead of repeating its arrival.
  releaseCreateRun();
  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
  await expect(chat.locator('[data-role="user"]').filter({ hasText: messageText })).toHaveCount(1);
  await expect(headerChip).toHaveAttribute("data-flown", "true");
  expect(await headerAnimations()).toHaveLength(2);

  // Reloading the conversation and opening it from the list show the chip without a flight.
  await page.reload();
  await expect(chat.locator('[data-role="user"]').filter({ hasText: messageText })).toHaveCount(1);
  await expect(headerChip).toContainText("Application Assistant");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(startChip).toContainText("Application Assistant");
  await expect(headerChip).toHaveCount(0);
  await page
    .getByTestId("conversation-row")
    .filter({ hasText: messageText })
    .getByRole("button")
    .first()
    .click();
  await expect(headerChip).toContainText("Application Assistant");
  expect(await headerAnimations()).toHaveLength(0);
});

test("the agent chip is simply in the header when motion is reduced", async ({ page }) => {
  const headerAnimations = await recordHeaderAnimations(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signInViaUi(page, normalUser);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);

  const startChip = page
    .getByRole("region", { name: "Chat" })
    .getByRole("button", { name: "Select agent" });
  const headerChip = page.locator("header").getByRole("button", { name: "Select agent" });
  const headerName = headerChip.locator("[data-agent-chip-name]");
  await expect(startChip).toContainText("Application Assistant");
  const startNameColor = await startChip
    .locator("[data-agent-chip-name]")
    .evaluate((name) => getComputedStyle(name).color);

  await page.getByPlaceholder("Message").fill(`Agent chip without motion ${Date.now()}`);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
  await expect(headerChip).toContainText("Application Assistant");
  await expect(startChip).toHaveCount(0);
  expect(await headerAnimations()).toHaveLength(0);
  // The name is quiet at once: the muted colour the chevron has, and the lighter weight.
  const mutedColor = await headerChip
    .locator("svg")
    .last()
    .evaluate((chevron) => getComputedStyle(chevron).color);
  expect(mutedColor).not.toBe(startNameColor);
  await expect(headerName).toHaveCSS("color", mutedColor);
  await expect(headerName).toHaveCSS("font-weight", "500");
});

test("composer sends on Enter and inserts a newline on Shift+Enter", async ({ page }) => {
  await signInViaUi(page, normalUser);
  let createRunRequests = 0;
  let legacyChatRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === "/api/conversations/runs") {
      createRunRequests += 1;
    }
    if (request.method() === "POST" && pathname === "/api/chat") {
      legacyChatRequests += 1;
    }
  });

  await page.goto("/");

  const input = page.getByPlaceholder("Message");
  await expect(input).toBeVisible();

  const messageText = `Keyboard submit ${Date.now()}`;
  await input.fill(messageText);
  await input.focus();
  await page.keyboard.down("Shift");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Shift");
  await expect(input).toHaveValue(`${messageText}\n`);
  expect(createRunRequests).toBe(0);
  expect(legacyChatRequests).toBe(0);

  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await input.press("Enter");
  await createRunResponse;

  expect(createRunRequests).toBe(1);
  expect(legacyChatRequests).toBe(0);
  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
  await expect(input).toHaveValue("");
});

test(
  "active runs block Enter without clearing the draft",
  { tag: "@chat-state" },
  async ({ page }) => {
    await signInViaUi(page, normalUser);
    await page.goto("/");

    const input = page.getByPlaceholder("Message");
    const suffix = Date.now();
    const longMessage = Array.from(
      { length: 240 },
      (_, index) => `active-run-guard-${suffix}-${index}`
    ).join(" ");
    await input.fill(longMessage);
    await input.press("Enter");
    await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

    const conversationId = currentConversationId(page);
    const runPath = `/api/conversations/${conversationId}/runs`;
    let followUpRunRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === runPath) {
        followUpRunRequests += 1;
      }
    });

    const followUpDraft = `Keep this draft ${suffix}`;
    await input.fill(followUpDraft);
    await input.press("Enter");
    await page.waitForTimeout(250);

    expect(followUpRunRequests).toBe(0);
    await expect(input).toHaveValue(followUpDraft);
    await expect(page.getByText("Conversation already has an active agent run")).toHaveCount(0);

    await stopActiveRun(page);
    await expect(input).toHaveValue(followUpDraft);
  }
);

test("links in user messages keep the bubble foreground contrast", async ({ page }) => {
  await signInViaApi(page, normalUser);
  await page.goto("/");

  const input = page.getByPlaceholder("Message");
  await input.fill("[Visible link](https://example.com)");
  await input.press("Enter");

  const userMessage = page.getByRole("region", { name: "Chat" }).locator('[data-role="user"]');
  const bubble = userMessage.locator(".chat-user-message-bubble");
  const link = userMessage.locator('[data-streamdown="link"]', { hasText: "Visible link" });
  await expect(link).toBeVisible();

  const colors = await link.evaluate((element) => ({
    link: getComputedStyle(element).color,
    bubble: getComputedStyle(element.closest(".chat-user-message-bubble") as Element).color,
    decoration: getComputedStyle(element).textDecorationLine
  }));
  expect(colors.link).toBe(colors.bubble);
  expect(colors.decoration).toContain("underline");
  await expect(bubble).toBeVisible();
});

test("new turns anchor below the top chrome and retain response runway", async ({ page }) => {
  await signInViaApi(page, normalUser);
  await page.goto("/");

  const input = page.getByPlaceholder("Message");
  await input.fill(`Anchor warmup ${Date.now()}`);
  await input.press("Enter");
  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
  await expect(page.getByText(/Local agent response:/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

  const messageText = `/tool demo.weather_forecast {"location":"Berlin","days":5,"unit":"celsius"}`;
  try {
    await input.fill(messageText);
    await input.press("Enter");

    const chat = page.getByRole("region", { name: "Chat" });
    const viewport = chat.locator(".chat-thread-inset");
    const anchoredMessage = chat.locator("[data-aui-top-anchor-user]");
    const bubble = anchoredMessage.locator(".chat-user-message-bubble");
    const reserve = chat.locator("[data-aui-top-anchor-reserve]");
    const expectedAnchorOffset = await page.evaluate(() =>
      Math.round(Math.min(250, Math.max(100, window.innerHeight * 0.2)))
    );

    await expect(anchoredMessage).toHaveCount(1);
    await expect(reserve).toHaveCount(1);
    await expect
      .poll(async () => {
        const [viewportBox, bubbleBox] = await Promise.all([
          viewport.boundingBox(),
          bubble.boundingBox()
        ]);
        if (!viewportBox || !bubbleBox) return 0;
        return Math.round(bubbleBox.y - viewportBox.y);
      })
      .toBe(expectedAnchorOffset);
    await expect
      .poll(() => reserve.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(0);

    const previousAssistant = chat.locator('[data-role="assistant"]').first();
    await expect
      .poll(async () => {
        const [assistantBox, bubbleBox] = await Promise.all([
          previousAssistant.boundingBox(),
          bubble.boundingBox()
        ]);
        if (!assistantBox || !bubbleBox) return Number.POSITIVE_INFINITY;
        return Math.round(bubbleBox.y - (assistantBox.y + assistantBox.height));
      })
      .toBeLessThanOrEqual(32);

    const anchoredPositions: number[] = [];
    for (let sample = 0; sample < 8; sample += 1) {
      anchoredPositions.push(await bubble.evaluate((element) => element.getBoundingClientRect().y));
      await page.waitForTimeout(75);
    }
    expect(Math.max(...anchoredPositions) - Math.min(...anchoredPositions)).toBeLessThanOrEqual(1);

    const activity = page.getByTestId("run-activity");
    await expect(activity).toBeVisible();
    const activityBeforeReserve = await Promise.all([
      activity.boundingBox(),
      reserve.boundingBox()
    ]);
    expect(activityBeforeReserve[0]?.y).toBeLessThan(activityBeforeReserve[1]?.y ?? 0);

    const transcriptPadding = await anchoredMessage.evaluate((element) => {
      const transcript = element.parentElement;
      return transcript ? Number.parseFloat(getComputedStyle(transcript).paddingBottom) : 0;
    });
    expect(transcriptPadding).toBe(64);

    await expect(page.getByText(/Tool work completed:/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await expect(anchoredMessage).toHaveCount(1);
    await expect(reserve).toHaveCount(1);
    await expect
      .poll(async () => {
        const [viewportBox, bubbleBox] = await Promise.all([
          viewport.boundingBox(),
          bubble.boundingBox()
        ]);
        if (!viewportBox || !bubbleBox) return 0;
        return Math.round(bubbleBox.y - viewportBox.y);
      })
      .toBe(expectedAnchorOffset);

    await page.reload();
    await expect(page.getByPlaceholder("Message")).toBeVisible();
    await expect(anchoredMessage).toHaveCount(0);
    await expect(reserve).toHaveCount(0);
    await expect
      .poll(() =>
        viewport.evaluate((element) =>
          Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight)
        )
      )
      .toBeLessThanOrEqual(1);
  } finally {
    await stopActiveRun(page);
  }
});

test("new conversation action opens an unsaved draft screen", async ({ page }) => {
  await signInViaUi(page, normalUser);
  let createConversationRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/conversations") {
      createConversationRequests += 1;
    }
  });

  await page.goto("/");
  const newConversationButton = page.getByRole("button", { name: "New", exact: true });
  await expect(newConversationButton).toBeVisible();
  await expect(page.getByRole("button", { name: "Select agent" })).toContainText(
    "Application Assistant"
  );
  await expect(page.getByRole("button", { name: "Add attachment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Find review risks" })).toBeVisible();

  const input = page.getByPlaceholder("Message");
  await input.fill("Draft on the new screen");
  await newConversationButton.click();

  expect(createConversationRequests).toBe(0);
  await expect(input).toHaveValue("Draft on the new screen");
  await expect(input).toBeFocused();
});

test("new conversation action returns from a persisted conversation to a clean draft route", async ({
  page
}) => {
  await signInViaUi(page, normalUser);
  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  const messageText = `New action route reset ${Date.now()}`;

  await input.fill(messageText);
  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await createRunResponse;
  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);

  const conversationId = currentConversationId(page);
  const createdConversation = page.getByTestId("conversation-row").filter({ hasText: messageText });
  await expect(createdConversation).toHaveCount(1);
  await expect(createdConversation).toHaveAttribute("data-selected", "true");

  await page.getByRole("button", { name: "New", exact: true }).click();

  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(createdConversation).toHaveCount(1);

  await createdConversation.getByRole("button").first().click();
  await expect(page).toHaveURL(conversationUrlPattern(conversationId));
});

test("standalone conversation routes are addressable and follow rail navigation", async ({
  page
}) => {
  await signInViaApi(page, normalUser);
  const title = `Route target ${Date.now()}`;
  const conversation = await createListedConversation(page, title);

  await page.goto(legacyConversationPath(conversation.id));
  const input = page.getByPlaceholder("Message");
  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: title });
  await expect(input).toBeVisible();
  await expect(targetConversation).toHaveAttribute("data-selected", "true");
  await expect(page).toHaveURL(conversationUrlPattern(conversation.id));

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  await input.fill("Route-scoped new draft");

  await targetConversation.getByRole("button").first().click();
  await expect(page).toHaveURL(conversationUrlPattern(conversation.id));
  await expect(input).toHaveValue("");

  await page.goBack();
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  await expect(input).toHaveValue("Route-scoped new draft");
});

test("collaboration workspaces scope navigation, settings, and discovery", async ({ page }) => {
  await signInViaUi(page, normalUser);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  const personalPathname = new URL(page.url()).pathname;

  const selectorTrigger = page.getByTestId("collaboration-workspace-selector-trigger");
  await expect(selectorTrigger).toContainText("Personal workspace");

  const workspaceName = `E2E Workspace ${Date.now()}`;
  await selectorTrigger.click();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByLabel("Name").fill(workspaceName);
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(selectorTrigger).toContainText(workspaceName);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  const sharedPathname = new URL(page.url()).pathname;
  expect(sharedPathname).not.toBe(personalPathname);

  const input = page.getByPlaceholder("Message");
  const messageText = `Workspace scoped ${Date.now()}`;
  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await input.fill(messageText);
  await page.getByRole("button", { name: "Send message" }).click();
  const response = await createRunResponse;
  expect(response.ok()).toBe(true);
  const started = (await response.json()) as { conversation: { id: string } };
  await expect(page).toHaveURL(conversationUrlPattern(started.conversation.id));
  expect(new URL(page.url()).pathname.startsWith(`${sharedPathname}/c/`)).toBe(true);
  // This test is about workspace scoping, not about the agent run, so the run is
  // cancelled best-effort: whether it streams, fails, or already finished must not
  // decide the outcome of the assertions below.
  await page
    .getByRole("button", { name: "Stop generating" })
    .click({ timeout: 5_000 })
    .catch(() => undefined);

  const workspaceConversation = page
    .getByTestId("conversation-row")
    .filter({ hasText: messageText });
  await expect(workspaceConversation).toHaveCount(1);

  const renamedWorkspaceName = `${workspaceName} renamed`;
  await selectorTrigger.click();
  await page.getByRole("button", { name: `Settings for ${workspaceName}` }).click();
  await page.getByLabel("Name").fill(renamedWorkspaceName);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(selectorTrigger).toContainText(renamedWorkspaceName);
  await page.getByRole("button", { name: "Close dialog" }).click();

  await selectorTrigger.click();
  await page.getByRole("button", { name: "Browse workspaces" }).click();
  await expect(
    page.getByTestId("collaboration-workspace-directory-row").filter({
      hasText: renamedWorkspaceName
    })
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Close dialog" }).click();

  await selectorTrigger.click();
  await page.getByRole("button", { name: "Personal workspace" }).click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(personalPathname)}$`, "u"));
  await expect(workspaceConversation).toHaveCount(0);

  await selectorTrigger.click();
  await page.getByRole("button", { name: renamedWorkspaceName, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(sharedPathname)}$`, "u"));

  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(sharedPathname)}$`, "u"));

  await page.goto("/w/cw_not_a_workspace");
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(personalPathname)}$`, "u"));
});

test("conversation rail moves a conversation into another workspace", async ({ page }) => {
  await signInViaApi(page, normalUser);

  const destinationName = `E2E Move Target ${Date.now()}`;
  const createdCollaborationWorkspace = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/collaboration-workspaces`,
    { data: { name: destinationName, visibility: "private" } }
  );
  expect(createdCollaborationWorkspace.ok()).toBe(true);
  const destinationCollaborationWorkspace = (await createdCollaborationWorkspace.json()) as {
    id: string;
  };

  const title = `Move target ${Date.now()}`;
  const conversation = await createListedConversation(page, title);

  await page.goto(legacyConversationPath(conversation.id));
  await expect(page).toHaveURL(conversationUrlPattern(conversation.id));
  const personalPathname = new URL(page.url()).pathname.replace(/\/c\/.*$/u, "");

  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: title });
  await expect(targetConversation).toHaveCount(1);

  await targetConversation
    .getByRole("button", { name: `Conversation options for ${title}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move to workspace…", exact: true }).click();
  const moveDialog = page.getByRole("dialog", { name: "Move conversation", exact: true });
  await expect(moveDialog).toBeVisible();
  // The workspace the conversation already lives in is never a destination.
  await expect(moveDialog.getByRole("radio", { name: "Personal workspace" })).toHaveCount(0);
  await expect(moveDialog.getByRole("radio", { name: destinationName })).toHaveCount(1);

  await moveDialog.getByRole("radio", { name: destinationName }).check();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /^\/api\/conversations\/[^/]+\/move$/u.test(new URL(response.url()).pathname)
    ),
    moveDialog.getByRole("button", { name: "Move", exact: true }).click()
  ]);

  const destinationPathname = `/w/${encodeURIComponent(destinationCollaborationWorkspace.id)}`;
  await expect(page).toHaveURL(
    new RegExp(
      `${escapeRegExp(destinationPathname)}/c/${escapeRegExp(encodeURIComponent(conversation.id))}$`,
      "u"
    )
  );
  await expect(moveDialog).toHaveCount(0);
  await expect(targetConversation).toHaveCount(1);

  const selectorTrigger = page.getByTestId("collaboration-workspace-selector-trigger");
  await expect(selectorTrigger).toContainText(destinationName);

  // Now that the conversation sits in the shared workspace, the Personal
  // Workspace is offered back under its fixed localized label.
  await targetConversation
    .getByRole("button", { name: `Conversation options for ${title}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Move to workspace…", exact: true }).click();
  await expect(moveDialog.getByRole("radio", { name: "Personal workspace" })).toHaveCount(1);
  await moveDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(moveDialog).toHaveCount(0);

  await selectorTrigger.click();
  await page.getByRole("button", { name: "Personal workspace" }).click();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(personalPathname)}$`, "u"));
  await expect(targetConversation).toHaveCount(0);
});

test("collaboration workspace settings delete a workspace and fall back to personal", async ({
  page
}) => {
  await signInViaApi(page, normalUser);

  const workspaceName = `E2E Delete ${Date.now()}`;
  const createdCollaborationWorkspace = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/collaboration-workspaces`,
    { data: { name: workspaceName, visibility: "discoverable" } }
  );
  expect(createdCollaborationWorkspace.ok()).toBe(true);
  const collaborationWorkspace = (await createdCollaborationWorkspace.json()) as { id: string };

  await page.goto("/");
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  const personalPathname = new URL(page.url()).pathname;

  await page.goto(`/w/${collaborationWorkspace.id}`);
  const selectorTrigger = page.getByTestId("collaboration-workspace-selector-trigger");
  await expect(selectorTrigger).toContainText(workspaceName);

  await selectorTrigger.click();
  await page.getByRole("button", { name: `Settings for ${workspaceName}` }).click();
  await page.getByTestId("collaboration-workspace-delete-trigger").click();

  const deleteDialog = page.getByRole("dialog", { name: "Delete workspace?", exact: true });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByTestId("collaboration-workspace-deletion-impact")).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Continue", exact: true }).click();

  const confirmInput = deleteDialog.getByLabel(`Type "${workspaceName}" to confirm`);
  const confirmButton = deleteDialog.getByRole("button", { name: "Delete workspace", exact: true });
  await confirmInput.fill(`${workspaceName} not really`);
  await expect(confirmButton).toBeDisabled();

  await confirmInput.fill(workspaceName);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        /^\/api\/collaboration-workspaces\/[^/]+$/u.test(new URL(response.url()).pathname)
    ),
    confirmButton.click()
  ]);

  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(personalPathname)}$`, "u"));
  await expect(selectorTrigger).toContainText("Personal workspace");

  await selectorTrigger.click();
  await page.getByRole("button", { name: "Browse workspaces" }).click();
  await expect(
    page.getByTestId("collaboration-workspace-directory-row").filter({ hasText: workspaceName })
  ).toHaveCount(0);
});

test("a superadmin manages a shared workspace without being a member", async ({
  page,
  browser
}) => {
  const workspaceName = `E2E Team ${Date.now()}`;
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signInViaApi(memberPage, normalUser);
  const createdCollaborationWorkspace = await requestWithOrigin(
    memberPage,
    "post",
    `${apiBaseUrl}/api/collaboration-workspaces`,
    { data: { name: workspaceName, visibility: "private" } }
  );
  expect(createdCollaborationWorkspace.ok()).toBe(true);
  const collaborationWorkspace = (await createdCollaborationWorkspace.json()) as { id: string };
  await memberContext.close();

  await signInViaApi(page, superadminUser);
  await page.goto("/");
  const selectorTrigger = page.getByTestId("collaboration-workspace-selector-trigger");
  await selectorTrigger.click();
  await expect(page.getByText("Other workspaces")).toBeVisible();
  await page.getByRole("button", { name: `Settings for ${workspaceName}` }).click();
  await expect(page.getByText("Superadmin, not a member")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Leave workspace" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Members" }).click();
  await expect(page.getByText(normalUser.email)).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();

  await selectorTrigger.click();
  await page.getByRole("button", { name: workspaceName, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${collaborationWorkspace.id}$`, "u"));
  await expect(selectorTrigger).toContainText(workspaceName);
  await expect(page.getByPlaceholder("Message")).toBeVisible();
});

test("first message from the root route moves to the persisted conversation route", async ({
  page
}) => {
  await signInViaUi(page, normalUser);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  let legacyChatRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") {
      legacyChatRequests += 1;
    }
  });

  const messageText = `Route creation ${Date.now()}`;
  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await page.getByPlaceholder("Message").fill(messageText);
  await page.getByRole("button", { name: "Send message" }).click();
  const response = await createRunResponse;
  expect(response.ok()).toBe(true);
  const started = (await response.json()) as { conversation: { id: string } };

  await expect(page).toHaveURL(conversationUrlPattern(started.conversation.id));
  expect(legacyChatRequests).toBe(0);
  const createdConversation = page.getByTestId("conversation-row").filter({ hasText: messageText });
  await expect(createdConversation).toHaveAttribute("data-selected", "true");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  await expect(page.getByPlaceholder("Message")).toHaveValue("");
  await expect(createdConversation).toHaveCount(1);
});

test("root submit stays draft-only while create-run is pending", async ({ page }) => {
  await signInViaUi(page, normalUser);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);

  let releaseCreateRun = () => {};
  const createRunGate = new Promise<void>((resolve) => {
    releaseCreateRun = resolve;
  });
  let createRunRequests = 0;
  let legacyChatRequests = 0;
  await page.route(`${apiBaseUrl}/api/conversations/runs`, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    createRunRequests += 1;
    await createRunGate;
    await route.continue();
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") {
      legacyChatRequests += 1;
    }
  });

  const input = page.getByPlaceholder("Message");
  const chatRegion = page.getByRole("region", { name: "Chat" });
  const messageText = `Delayed route creation ${Date.now()}`;
  await input.fill(messageText);
  const createRunResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/conversations/runs"
  );
  await page.getByRole("button", { name: "Send message" }).click();

  await expect.poll(() => createRunRequests).toBe(1);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
  await expect(input).toHaveValue(messageText);
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(
    chatRegion.locator('[data-role="user"]').filter({ hasText: messageText })
  ).toHaveCount(0);
  await expect(page.getByTestId("run-activity")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
  expect(legacyChatRequests).toBe(0);

  releaseCreateRun();
  const response = await createRunResponse;
  expect(response.ok()).toBe(true);
  const started = (await response.json()) as { conversation: { id: string } };

  await expect(page).toHaveURL(conversationUrlPattern(started.conversation.id));
  await expect(input).toHaveValue("");
  await expect(
    chatRegion.locator('[data-role="user"]').filter({ hasText: messageText })
  ).toHaveCount(1);
  expect(createRunRequests).toBe(1);
  expect(legacyChatRequests).toBe(0);
});

test("stop generating cancels the active stream instead of only hiding the button", async ({
  page
}) => {
  await signInViaUi(page, normalUser);

  await page.goto("/");
  const suffix = Date.now();
  const input = page.getByPlaceholder("Message");
  const messageTokens = Array.from({ length: 240 }, (_, index) => `stop-token-${suffix}-${index}`);
  const lateToken = messageTokens.at(-1) ?? "";
  const messageText = messageTokens.join(" ");
  expect(lateToken).not.toBe("");
  await input.fill(messageText);
  await input.press("Enter");
  await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);

  const stopButton = page.getByRole("button", { name: "Stop generating" });
  await expect(stopButton).toBeVisible();
  await expect(stopButton).toBeEnabled();
  await stopButton.click({ timeout: 5_000 });

  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 10_000 });
  await expect(stopButton).toHaveCount(0);
  await page.waitForTimeout(6_000);

  await expect(page.locator('[data-role="assistant"]').filter({ hasText: lateToken })).toHaveCount(
    0
  );

  const conversationId = currentConversationId(page);
  const messages = await page.request.get(
    `${apiBaseUrl}/api/conversations/${conversationId}/messages`
  );
  expect(messages.ok()).toBe(true);
  const persistedMessages = (await messages.json()) as Array<{ role: string; text: string }>;
  const persistedAssistantText = persistedMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
  expect(persistedAssistantText).not.toContain(lateToken);
});

test("composer drafts are scoped to the new screen and selected conversations", async ({
  page
}) => {
  await signInViaApi(page, normalUser);
  const title = `Draft target ${Date.now()}`;
  await createListedConversation(page, title);

  await page.goto("/");
  const input = page.getByPlaceholder("Message");
  await input.fill("New screen draft");

  const targetConversation = page.getByTestId("conversation-row").filter({ hasText: title });
  await expect(targetConversation).toHaveCount(1);
  await targetConversation.getByRole("button").first().click();
  await expect(input).toHaveValue("");
  await input.fill("Selected conversation draft");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(input).toHaveValue("New screen draft");

  await targetConversation.getByRole("button").first().click();
  await expect(input).toHaveValue("Selected conversation draft");
});

test(
  "conversation switching isolates pending stream state",
  { tag: "@chat-state" },
  async ({ page }) => {
    await signInViaUi(page, normalUser);
    const suffix = Date.now();
    const sourceTitle = `Streaming source ${suffix}`;
    const targetTitle = `Stable target ${suffix}`;
    await createListedConversation(page, sourceTitle);
    await createListedConversation(page, targetTitle);

    // The server accepts the run; what stays pending is its event stream, the request that
    // carries the answer to the page.
    let streamRequestStarted = false;
    let releaseStream: () => void = () => {};
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const runEventsRoute = new RegExp(
      `${escapeRegExp(apiBaseUrl)}/api/conversations/[^/]+/runs/[^/]+/events(?:\\?.*)?$`,
      "u"
    );
    await page.route(runEventsRoute, async (route) => {
      streamRequestStarted = true;
      await streamGate;
      await route.abort("aborted").catch(() => undefined);
    });

    try {
      await page.goto("/");
      const input = page.getByPlaceholder("Message");
      const chatRegion = page.getByRole("region", { name: "Chat" });
      const sourceConversation = page
        .getByTestId("conversation-row")
        .filter({ hasText: sourceTitle });
      const targetConversation = page
        .getByTestId("conversation-row")
        .filter({ hasText: targetTitle });
      await expect(sourceConversation).toHaveCount(1);
      await expect(targetConversation).toHaveCount(1);

      await sourceConversation.getByRole("button").first().click();
      const sendButton = page.getByRole("button", { name: "Send message" });
      await expect(sendButton).toBeEnabled();
      // Long enough that the run is still going while the test switches back and forth.
      const messageToken = `session-isolation-${suffix}`;
      await input.fill(
        Array.from({ length: 240 }, (_, index) => `${messageToken}-${index}`).join(" ")
      );
      await sendButton.click();
      await expect(chatRegion.getByText(messageToken, { exact: false }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
      await expect.poll(() => streamRequestStarted).toBe(true);
      await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

      await targetConversation.getByRole("button").first().click();
      await expect(chatRegion.getByText(messageToken, { exact: false })).toHaveCount(0);
      await expect(page.getByTestId("run-activity")).toHaveCount(0);
      await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

      // Back in the source the run shows as in progress and the composer offers to stop it
      // instead of sending.
      await sourceConversation.getByRole("button").first().click();
      await expect(page.getByTestId("run-activity")).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
    } finally {
      releaseStream();
      await page.unroute(runEventsRoute);
    }
    await stopActiveRun(page);
  }
);

test(
  "switching back to a running conversation resumes one stream indicator",
  { tag: "@chat-state" },
  async ({ page }) => {
    await signInViaUi(page, normalUser);
    const suffix = Date.now();
    const sourceTitle = `Resume source ${suffix}`;
    const targetTitle = `Resume target ${suffix}`;
    const conversation = await createListedConversation(page, sourceTitle);
    await createListedConversation(page, targetTitle);

    const eventRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "GET" &&
        isRunEventsPath(url.pathname) &&
        url.pathname.startsWith(`/api/conversations/${conversation.id}/runs/`)
      ) {
        eventRequests.push(request.url());
      }
    });

    await page.goto("/");
    const input = page.getByPlaceholder("Message");
    const chatRegion = page.getByRole("region", { name: "Chat" });
    const sourceConversation = page
      .getByTestId("conversation-row")
      .filter({ hasText: sourceTitle });
    const targetConversation = page
      .getByTestId("conversation-row")
      .filter({ hasText: targetTitle });
    await expect(sourceConversation).toHaveCount(1);
    await expect(targetConversation).toHaveCount(1);

    await sourceConversation.getByRole("button").first().click();
    const uniqueToken = `resume-token-${suffix}`;
    await input.fill(Array.from({ length: 90 }, (_, index) => `${uniqueToken}-${index}`).join(" "));
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();
    await expect(page.getByTestId("run-activity")).toHaveCount(1);
    await expect.poll(() => eventRequests.length).toBeGreaterThan(0);

    await targetConversation.getByRole("button").first().click();
    await expect(chatRegion.getByText(uniqueToken)).toHaveCount(0);

    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();
    const eventRequestCountBeforeReturn = eventRequests.length;
    await sourceConversation.getByRole("button").first().click();
    await expect(page.getByTestId("run-activity")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
    await expect.poll(() => eventRequests.length).toBeGreaterThan(eventRequestCountBeforeReturn);
    await expect(chatRegion.getByText(uniqueToken, { exact: false }).first()).toBeVisible({
      timeout: 15_000
    });
    await expect(page.getByTestId("run-activity")).toHaveCount(0);
    await stopActiveRun(page);
  }
);

test(
  "direct conversation links resume a running stream from stored state",
  { tag: "@chat-state" },
  async ({ page }) => {
    await signInViaUi(page, normalUser);
    const suffix = Date.now();
    const sourceTitle = `Direct resume source ${suffix}`;
    const conversation = await createListedConversation(page, sourceTitle);

    const eventRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && isRunEventsPath(url.pathname)) {
        eventRequests.push(request.url());
      }
    });

    await page.goto(legacyConversationPath(conversation.id));
    const input = page.getByPlaceholder("Message");
    const chatRegion = page.getByRole("region", { name: "Chat" });
    const sourceConversation = page
      .getByTestId("conversation-row")
      .filter({ hasText: sourceTitle });
    await expect(sourceConversation).toHaveCount(1);

    const uniqueToken = `direct-resume-token-${suffix}`;
    await input.fill(
      Array.from({ length: 100 }, (_, index) => `${uniqueToken}-${index}`).join(" ")
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    await page.goto(legacyConversationPath(conversation.id));
    const runningConversation = page.getByTestId("conversation-row").filter({
      has: page.getByTestId("conversation-running-indicator")
    });
    await expect(runningConversation).toHaveCount(1);
    await expect(runningConversation).toHaveAttribute("data-selected", "true");
    await expect.poll(() => eventRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(
      chatRegion.locator('[data-role="assistant"]').filter({ hasText: uniqueToken }).first()
    ).toBeVisible({
      timeout: 15_000
    });
    await expect(page.getByTestId("run-activity")).toHaveCount(0);
    await stopActiveRun(page);
  }
);

test(
  "new conversation run completion does not steal the selected conversation",
  { tag: "@chat-state" },
  async ({ page }) => {
    await signInViaUi(page, normalUser);
    const suffix = Date.now();
    const targetTitle = `Switch target ${suffix}`;
    await createListedConversation(page, targetTitle);

    await page.goto("/");
    const input = page.getByPlaceholder("Message");
    const chatRegion = page.getByRole("region", { name: "Chat" });
    const sendButton = page.getByRole("button", { name: "Send message" });
    const messageToken = `new-run-isolation-${suffix}`;
    const messageText = Array.from({ length: 120 }, (_, index) => `${messageToken}-${index}`).join(
      " "
    );
    await input.fill(messageText);
    await expect(sendButton).toBeEnabled();
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/conversations/runs"
      ),
      sendButton.click()
    ]);
    await expect(page).toHaveURL(collaborationWorkspaceConversationUrlPattern);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
    await expect(page.getByTestId("run-activity")).toHaveCount(1);
    const newConversation = page.getByTestId("conversation-row").filter({ hasText: messageToken });
    await expect(newConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    const targetConversation = page
      .getByTestId("conversation-row")
      .filter({ hasText: targetTitle });
    await targetConversation.getByRole("button").first().click();
    await expect(targetConversation).toHaveAttribute("data-selected", "true");
    await expect(chatRegion.getByText(messageToken, { exact: false })).toHaveCount(0);
    await expect(page.getByTestId("run-activity")).toHaveCount(0);
    await expect(newConversation).toHaveCount(1);
    await expect(newConversation.getByTestId("conversation-running-indicator")).toHaveCount(0);
    await expect(targetConversation).toHaveAttribute("data-selected", "true");
  }
);

test(
  "completed background turns are marked unread until viewed",
  { tag: "@chat-state" },
  async ({ page }) => {
    await signInViaUi(page, normalUser);
    const suffix = Date.now();
    const sourceTitle = `Unread source ${suffix}`;
    const targetTitle = `Unread target ${suffix}`;
    await createListedConversation(page, sourceTitle);
    await createListedConversation(page, targetTitle);

    const eventRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && isRunEventsPath(url.pathname)) {
        eventRequests.push(request.url());
      }
    });

    await page.goto("/");
    const input = page.getByPlaceholder("Message");
    const chatRegion = page.getByRole("region", { name: "Chat" });
    const sourceConversation = page
      .getByTestId("conversation-row")
      .filter({ hasText: sourceTitle });
    const targetConversation = page
      .getByTestId("conversation-row")
      .filter({ hasText: targetTitle });
    await expect(sourceConversation).toHaveCount(1);
    await expect(targetConversation).toHaveCount(1);

    await sourceConversation.getByRole("button").first().click();
    const sendButton = page.getByRole("button", { name: "Send message" });
    await expect(sendButton).toBeEnabled();
    const forecastLocation = `Unread background ${suffix}`;
    await input.fill(
      `/tool demo.weather_forecast {"location":"${forecastLocation}","days":3,"unit":"celsius","startDate":"2026-06-13"}`
    );
    await sendButton.click();
    await expect(sourceConversation.getByTestId("conversation-running-indicator")).toBeVisible();

    await targetConversation.getByRole("button").first().click();
    await expect(sourceConversation.getByTestId("conversation-unread-indicator")).toBeVisible({
      timeout: 20_000
    });

    const eventRequestCountBeforeView = eventRequests.length;
    await sourceConversation.getByRole("button").first().click();
    await page.waitForTimeout(500);
    expect(eventRequests).toHaveLength(eventRequestCountBeforeView);
    await expect(sourceConversation.getByTestId("conversation-unread-indicator")).toHaveCount(0);
    await expect(page.getByTestId("run-activity")).toHaveCount(0);
    const toolCallCard = await openWorkHistoryToolCard(chatRegion);
    await expect(toolCallCard).toContainText("Completed");
    // In the work history the card is a disclosure; its details hold the tool input.
    await expandDisclosure(toolCallCard.getByRole("button", { name: /^Weather Forecast/u }));
    await expect(toolCallCard).toContainText(forecastLocation);
    await expect(chatRegion.getByText("Tool work completed")).toHaveCount(1);
  }
);

test("conversation rail deletes a conversation", async ({ page }) => {
  await signInViaApi(page, normalUser);
  let deleteConversationRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      /^\/api\/conversations\/[^/]+$/u.test(new URL(request.url()).pathname)
    ) {
      deleteConversationRequests += 1;
    }
  });

  const title = `Delete target ${Date.now()}`;
  await createListedConversation(page, title);

  await page.goto("/");
  const conversations = page.getByTestId("conversation-row");
  const targetConversation = conversations.filter({ hasText: title });
  await expect(targetConversation).toHaveCount(1);

  const conversationCountBefore = await conversations.count();
  const optionsButton = targetConversation.getByRole("button", {
    name: `Conversation options for ${title}`,
    exact: true
  });
  await expect(optionsButton).toBeVisible();
  await optionsButton.click();
  await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Delete conversation?", exact: true })
  ).toBeVisible();
  expect(deleteConversationRequests).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Delete conversation?", exact: true })).toHaveCount(
    0
  );

  await optionsButton.click();
  await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        /^\/api\/conversations\/[^/]+$/u.test(new URL(response.url()).pathname)
    ),
    page.getByRole("button", { name: "Delete", exact: true }).click()
  ]);

  expect(deleteConversationRequests).toBe(1);
  await expect(targetConversation).toHaveCount(0);
  await expect(conversations).toHaveCount(conversationCountBefore - 1);
});

test("conversation rail renames from the menu and a later selected-title click", async ({
  page
}) => {
  await signInViaApi(page, normalUser);
  const initialTitle = `Rename target ${Date.now()}`;
  const menuTitle = `${initialTitle} menu`;
  const finalTitle = `${initialTitle} double click`;
  const otherTitle = `Rename navigation target ${Date.now()}`;
  await createListedConversation(page, initialTitle);
  await createListedConversation(page, otherTitle);
  await page.route("**/api/conversations/*/title", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await page.goto("/");
  const initialRow = page.getByTestId("conversation-row").filter({ hasText: initialTitle });
  await expect(initialRow).toHaveCount(1);
  await expect(initialRow.locator(".lucide-message-square")).toHaveCount(0);

  await initialRow
    .getByRole("button", { name: `Conversation options for ${initialTitle}` })
    .click();
  await page.getByRole("menuitem", { name: "Rename conversation", exact: true }).click();
  const titleInput = page.getByRole("textbox", { name: "Conversation title", exact: true });
  await expect(titleInput).toBeFocused();
  await expect(titleInput).toHaveValue(initialTitle);
  await titleInput.fill(menuTitle);
  const menuRenameResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/api\/conversations\/[^/]+\/title$/u.test(new URL(response.url()).pathname)
  );
  await titleInput.press("Enter");
  expect(await titleInput.count()).toBe(0);
  await menuRenameResponse;

  const renamedRow = page.getByTestId("conversation-row").filter({ hasText: menuTitle });
  await expect(renamedRow).toHaveCount(1);
  await renamedRow.getByRole("button").first().click();
  await expect(renamedRow).toHaveAttribute("data-selected", "true");
  await page.waitForTimeout(750);
  await renamedRow.getByText(menuTitle, { exact: true }).click();
  await expect(titleInput).toBeFocused();
  await expect(titleInput).toHaveValue(menuTitle);
  await titleInput.fill(finalTitle);
  const doubleClickRenameResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      /\/api\/conversations\/[^/]+\/title$/u.test(new URL(response.url()).pathname)
  );
  await titleInput.press("Enter");
  expect(await titleInput.count()).toBe(0);
  await doubleClickRenameResponse;
  const finalRow = page.getByTestId("conversation-row").filter({ hasText: finalTitle });
  await expect(finalRow).toHaveCount(1);

  await finalRow.getByText(finalTitle, { exact: true }).click();
  await titleInput.fill(`${finalTitle} unfinished`);
  const chatBounds = await page.getByRole("region", { name: "Chat", exact: true }).boundingBox();
  expect(chatBounds).not.toBeNull();
  await page.mouse.click(chatBounds!.x + 20, chatBounds!.y + 100);
  expect(await titleInput.count()).toBe(0);
  await expect(finalRow.getByText(finalTitle, { exact: true })).toBeVisible();

  await finalRow.getByText(finalTitle, { exact: true }).click();
  await titleInput.fill(`${finalTitle} unfinished again`);
  await page
    .getByTestId("conversation-row")
    .filter({ hasText: otherTitle })
    .getByRole("button")
    .first()
    .click();
  expect(await titleInput.count()).toBe(0);
  await expect(finalRow.getByText(finalTitle, { exact: true })).toBeVisible();
});

test("standalone auth gates superadmin views", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await expect(page.getByRole("button", { name: "Usage" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open administration panel" })).toBeVisible();

  await page.getByRole("button", { name: "E2E Superadmin account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
  await signInViaUi(page, normalUser, { alreadyOnLogin: true });
  await expect(page.getByRole("button", { name: "Open administration panel" })).toHaveCount(0);
});

test("standalone settings and superadmin tabs are route-backed", async ({ page }) => {
  await signInViaApi(page, superadminUser);

  await page.goto("/");
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page).toHaveURL(/\/admin\/users$/u);
  await expect(
    page
      .getByRole("region", { name: "Administration panel" })
      .getByRole("heading", { name: "Users" })
  ).toBeVisible();

  await page.goto("/settings");
  await expect(page.getByRole("region", { name: "User settings" })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/u);

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/users$/u);
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Administration panel" })
      .getByRole("heading", { name: "Users" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Config" }).click();
  await expect(page).toHaveURL(/\/admin\/config$/u);
  await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible();

  await page.getByRole("button", { name: "Usage" }).click();
  await expect(page).toHaveURL(/\/admin\/usage$/u);
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.getByText("Billable this month")).toBeVisible();

  await page.getByRole("button", { name: "Audit log" }).click();
  await expect(page).toHaveURL(/\/admin\/audit$/u);
  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toBeVisible();
  await expect(page.getByText("Recent activity")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/usage$/u);
  await expect(page.getByText("Billable this month")).toBeVisible();
});

test("superadmin config follows the German locale", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
  });
  await signInViaApi(page, superadminUser);

  await page.goto("/admin/config");

  await expect(page.getByRole("region", { name: "Administrationsbereich" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Administrationsbereiche" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Benutzer/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Konfiguration", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nutzung", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Auditprotokoll", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Konfiguration", exact: true })).toBeVisible();
  await expect(page.getByText("Agenten", { exact: true })).toBeVisible();
  await expect(page.getByText("Fähigkeiten", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Agenten oder Fähigkeit auswählen", exact: true })
  ).toBeVisible();

  await page
    .getByRole("region", { name: "Agenten", exact: true })
    .getByRole("button", { name: "research_assistant Alle Arbeitsbereiche", exact: true })
    .click();

  const form = page.locator("form");
  await expect(form.getByText("Identität und Begrüßung", { exact: true })).toBeVisible();
  await expect(form.getByText("Verhalten", { exact: true })).toBeVisible();
  await expect(form.getByText("Denkaufwand", { exact: true })).toBeVisible();
  await expect(form.getByRole("group", { name: "Werkzeuge", exact: true })).toBeVisible();
  await expect(form.getByRole("group", { name: "Fähigkeiten", exact: true })).toBeVisible();
  await expect(form.getByText("Einstiegsvorschläge", { exact: true })).toBeVisible();
  await expect(
    form.getByRole("button", { name: "Änderungen speichern", exact: true })
  ).toBeVisible();
  await expect(
    form.getByText("Gilt sofort für neue Unterhaltungen.", { exact: true })
  ).toBeVisible();
});

test("superadmin manages config assets with validation and conflict protection", async ({
  page
}) => {
  test.setTimeout(60_000);
  await signInViaApi(page, superadminUser);
  const originalResponse = await page.request.get(`${apiBaseUrl}/api/admin/config/export`);
  expect(originalResponse.ok()).toBe(true);
  const original = (await originalResponse.json()) as {
    version: number;
    defaultAgentName?: string;
    agents: Array<Record<string, unknown>>;
    skills: Array<Record<string, unknown>>;
  };
  const originalResearchAgent = original.agents.find(
    (agent) => agent.name === "research_assistant"
  );
  expect(originalResearchAgent).toBeDefined();

  const versionLabel = (version: number) => page.getByText(`Version ${version}`, { exact: false });
  const form = () => page.locator("form");
  const fieldset = (name: string) => form().getByRole("group", { name, exact: true });
  const fieldControl = (label: string, selector: string) =>
    form()
      .locator("label")
      .filter({ hasText: new RegExp(`^${label}`) })
      .locator(selector)
      .first();
  const clickAgent = async () => {
    await page
      .getByRole("region", { name: "Agents", exact: true })
      .getByRole("button", { name: "research_assistant All workspaces", exact: true })
      .click();
    await expect(form()).toBeVisible();
  };
  const clickSkill = async () => {
    await page.getByRole("button", { name: "config_e2e_skill", exact: true }).click();
    await expect(form()).toBeVisible();
  };

  try {
    await page.goto("/admin/config");
    await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/config$/u);
    await expect(versionLabel(original.version)).toBeVisible();

    await clickAgent();
    await expect
      .poll(() =>
        form()
          .getByRole("button", { name: "Save changes", exact: true })
          .locator("..")
          .evaluate((element) => getComputedStyle(element).position)
      )
      .toBe("static");
    await expect(fieldset("Tools").getByLabel("read_skill", { exact: true })).toBeVisible();
    await expect(fieldset("Tools").getByLabel("show_view", { exact: true })).toBeVisible();
    const firstPrompt = form().getByText("Prompt 1", { exact: true }).locator("../..");
    const firstPromptText = firstPrompt.locator("input").nth(2);
    // The agent's models are one list: each model can be made the default, and a model in use
    // carries its reasoning effort.
    const models = fieldset("Models");
    await expect(models.getByRole("radio")).toHaveCount(2);
    await expect(
      models.getByRole("radio", { name: "Instance default (local): Default", exact: true })
    ).toBeChecked();
    await expect(
      models.getByRole("radio", { name: "deterministic-local: Default", exact: true })
    ).not.toBeChecked();
    await expect(
      models
        .getByRole("combobox", { name: "Instance default (local): Reasoning effort", exact: true })
        .locator("option")
    ).toContainText(["Model default", "none", "low", "medium", "high", "xhigh"]);

    await page.getByRole("button", { name: "New skill", exact: true }).click();
    await page.locator('input[placeholder="generic_workflow_review"]').fill("config_e2e_skill");
    await fieldControl("Title", "input").fill("Config E2E skill");
    await fieldControl("Description", "input").fill("Verifies config asset editing");
    await fieldControl("Content", "textarea").fill("# Verify config assets");
    await form().getByRole("button", { name: "Create skill", exact: true }).click();
    await expect(versionLabel(original.version + 1)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Config E2E skill", exact: true })
    ).toBeVisible();
    await expect(fieldControl("Title", "input")).toHaveValue("Config E2E skill");
    await expect(fieldControl("Description", "input")).toHaveValue("Verifies config asset editing");
    await expect(fieldControl("Content", "textarea")).toHaveValue("# Verify config assets");

    await clickAgent();
    await fieldset("Skills").getByLabel("config_e2e_skill", { exact: true }).check();
    await form().getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(
      page.getByText(
        "Agent 'research_assistant' references skills but does not allow 'read_skill'",
        { exact: true }
      )
    ).toBeVisible();
    await expect(versionLabel(original.version + 1)).toBeVisible();

    await fieldset("Tools").getByLabel("read_skill", { exact: true }).check();
    const updatedPrompt = `Keep this saved prompt ${Date.now()}.`;
    await firstPromptText.fill(updatedPrompt);
    await form().getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(versionLabel(original.version + 2)).toBeVisible();
    await expect(firstPromptText).toHaveValue(updatedPrompt);

    await clickSkill();
    await form().getByRole("button", { name: "Delete", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Delete skill 'config_e2e_skill'?", exact: true })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(
      page.getByText("Agent 'research_assistant' references missing skill 'config_e2e_skill'", {
        exact: true
      })
    ).toBeVisible();
    await expect(versionLabel(original.version + 2)).toBeVisible();

    await clickAgent();
    await fieldset("Skills").getByLabel("config_e2e_skill", { exact: true }).uncheck();
    await form().getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(versionLabel(original.version + 3)).toBeVisible();
    await clickSkill();
    await form().getByRole("button", { name: "Delete", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Delete skill 'config_e2e_skill'?", exact: true })
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(versionLabel(original.version + 4)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Skills" }).getByText("None yet.", { exact: true })
    ).toBeVisible();

    await clickAgent();
    const instructions = fieldControl("Instructions", "textarea");
    const serverInstructions = `${String(originalResearchAgent?.instructions)}\n\nServer change.`;
    const serverChange = await requestWithOrigin(
      page,
      "put",
      `${apiBaseUrl}/api/admin/config/assets/agent/research_assistant`,
      {
        data: {
          baseVersion: original.version + 4,
          config: { ...originalResearchAgent, instructions: serverInstructions }
        }
      }
    );
    expect(serverChange.ok()).toBe(true);
    await instructions.fill(`${String(originalResearchAgent?.instructions)}\n\nUnsaved UI change.`);
    await form().getByRole("button", { name: "Save changes", exact: true }).click();
    const conflict = page.getByRole("dialog", {
      name: "Configuration changed on the server",
      exact: true
    });
    await expect(conflict).toBeVisible();
    await conflict.getByRole("button", { name: "Reload latest", exact: true }).click();
    await expect(conflict).toBeHidden();
    await expect(versionLabel(original.version + 5)).toBeVisible();
    await expect(fieldControl("Instructions", "textarea")).toHaveValue(serverInstructions);
  } finally {
    const restored = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/admin/config/import`,
      {
        data: {
          baseVersion: null,
          defaultAgentName: original.defaultAgentName,
          agents: original.agents,
          skills: original.skills
        }
      }
    );
    expect(restored.ok()).toBe(true);
  }
});

test("normal users are redirected away from superadmin routes", async ({ page }) => {
  await signInViaApi(page, normalUser);

  await page.goto("/admin/usage");

  await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Administration panel" })).toHaveCount(0);
  await expect(page).toHaveURL(collaborationWorkspaceUrlPattern);
});

test("workspace and superadmin keep page scroll locked", async ({ page }) => {
  await signInViaApi(page, superadminUser);
  const titlePrefix = `Scroll lock target ${Date.now()}`;
  await Promise.all(
    Array.from({ length: 18 }, (_, index) =>
      createListedConversation(page, `${titlePrefix} ${index}`)
    )
  );

  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
  await expectDocumentScrollLocked(page);

  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
  await expectDocumentScrollLocked(page);
});

test("superadmin can open usage and audit views", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await ensureDarkMode(page);
  await expect(page.getByRole("button", { name: "Open administration panel" })).toBeVisible();
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
  await expect(page.getByText("Administration")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Usage/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Users/ })).toBeVisible();
  await page.getByRole("button", { name: /^Users/ }).click();
  await expect
    .poll(() =>
      page
        .getByLabel("Filter by status")
        .evaluate((element) => getComputedStyle(element).backgroundColor)
    )
    .not.toBe("rgb(255, 255, 255)");
  await expect(page.getByRole("button", { name: "Audit log" })).toBeVisible();
});

test("admin sees billed usage and can manage users", async ({ page }) => {
  await signInViaUi(page, adminUser);
  await expect(page.getByRole("button", { name: "Open administration panel" })).toBeVisible();
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page).toHaveURL(/\/admin\/users$/u);
  const adminPanel = page.getByRole("region", { name: "Administration panel" });
  await expect(adminPanel).toBeVisible();
  await expect(adminPanel.getByText("Admin", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Usage/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Users/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audit log" })).toBeVisible();
  await page.getByRole("button", { name: /^Usage/ }).click();
  await expect(page).toHaveURL(/\/admin\/usage$/u);
  await expect(page.getByText("Billable this month")).toBeVisible();
  await expect(page.getByTestId("monthly-usage")).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await expect(page).toHaveURL(/\/admin\/users$/u);
  await page.getByRole("button", { name: "New user" }).click();
  const timestamp = Date.now();
  const createdUser = {
    displayLabel: `E2E Admin Created ${timestamp}`,
    email: `e2e-admin-created-${timestamp}@example.test`,
    password: `e2e-admin-created-${timestamp}`
  };
  const dialog = page.getByRole("dialog", { name: "New user" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Access level").locator('option[value="superadmin"]')).toHaveCount(
    0
  );
  await dialog.getByLabel("Display label").fill(createdUser.displayLabel);
  await dialog.getByLabel("Email").fill(createdUser.email);
  await dialog.getByLabel("Initial password").fill(createdUser.password);
  await dialog.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("dialog", { name: "User created" })).toBeVisible();
  await page.getByRole("button", { name: "Open user" }).click();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toBeVisible();
});

test("demo chat can run a configured tool widget", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  const forecastLocation = `Oslo ${Date.now()}`;
  const consoleErrors: string[] = [];
  let historyResponses = 0;
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "GET" &&
      /^\/api\/conversations\/[^/]+\/(?:messages|thread)$/u.test(url.pathname)
    ) {
      historyResponses += 1;
    }
  });

  await page.goto("/");
  await expect(page.getByRole("complementary", { name: "Conversations" })).toBeVisible();
  await page
    .getByPlaceholder("Message")
    .fill(
      `/tool demo.weather_forecast {"location":"${forecastLocation}","days":3,"unit":"celsius","startDate":"2026-06-13"}`
    );
  await page.getByRole("button", { name: "Send message" }).click();

  const chatRegion = page.getByRole("region", { name: "Chat" });
  await expect(page.getByText("Tool work completed").last()).toBeVisible();
  await expect(page.getByTestId("run-activity")).toHaveCount(0);
  await expect.poll(() => historyResponses).toBeGreaterThan(0);

  // Once the run has finished the widget stands below the answer.
  await expect(chatRegion.getByText("Weather forecast", { exact: true })).toBeVisible();
  await expect(chatRegion.getByText(forecastLocation, { exact: true })).toBeVisible();
  await expect(chatRegion.getByText("3-day forecast", { exact: true })).toBeVisible();

  // The tool call itself is kept in the work history of the finished run.
  const toolCallCard = await openWorkHistoryToolCard(chatRegion);
  await expect(toolCallCard).toContainText("Weather Forecast");
  await expect(toolCallCard).toContainText("Completed");

  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();
  await expect(page.getByText("Administration")).toBeVisible();
  await page.getByRole("button", { name: /^Usage/u }).click();
  await expect(page.getByText("Billable this month")).toBeVisible();
  await expect(page.getByText("Billable today")).toBeVisible();
  await expect(page.getByTestId("daily-usage")).toBeVisible();
  await expect(page.getByTestId("monthly-usage")).toBeVisible();
  await expect(page.getByText("Configured safeguards")).toBeVisible();
  const configuredSafeguards = page.getByTestId("configured-safeguards");
  await expect(configuredSafeguards).toContainText("500");
  await expect(configuredSafeguards).toContainText("25,000");
  await expect(page.getByText("Recent model usage")).toBeVisible();
  await expect(page.getByText("deterministic-local").first()).toBeVisible();
  await expect(page.getByText("not_reported").first()).toBeVisible();
  await page.getByRole("button", { name: "Audit log" }).click();
  await expect(page.getByText("Recent activity")).toBeVisible();
  // Tool runs are folded into their activity as evidence; expand the rows to reveal them.
  const adminRegion = page.getByRole("region", { name: "Administration panel" });
  const activityRows = adminRegion.locator("button[aria-expanded]");
  const rowCount = await activityRows.count();
  for (let index = 0; index < rowCount; index += 1) {
    await activityRows.nth(index).click();
  }
  await expect(page.getByText("tool.completed").first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("superadmin resets a user's password from the users panel", async ({ page }) => {
  // Make sure the normal user exists in the platform user store before administering it.
  await signInViaApi(page, normalUser);
  const normalMe = await page.request.get(`${apiBaseUrl}/api/me`);
  expect(normalMe.ok()).toBe(true);
  await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-out`, { data: {} });
  await page.context().clearCookies();

  await signInViaUi(page, superadminUser);
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await page.getByRole("button", { name: `E2E User ${normalUser.email}` }).click();
  await expect(page.getByRole("heading", { name: "Sign-in identities" })).toBeVisible();

  const temporaryPassword = `e2e-reset-${Date.now()}`;
  await page.getByLabel("New password").fill(temporaryPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password updated", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "E2E Superadmin account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();

  await signInViaUi(
    page,
    { email: normalUser.email, password: temporaryPassword },
    { alreadyOnLogin: true }
  );
  await expect(page.getByText("E2E User")).toBeVisible();

  // Restore the seeded password so reruns against a reused server stay consistent.
  await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-out`, { data: {} });
  await page.context().clearCookies();
  await signInViaApi(page, superadminUser);
  const usersResponse = await page.request.get(`${apiBaseUrl}/api/superadmin/users`);
  expect(usersResponse.ok()).toBe(true);
  const administeredUsers = (await usersResponse.json()) as Array<{ id: string; email?: string }>;
  const target = administeredUsers.find((candidate) => candidate.email === normalUser.email);
  expect(target).toBeDefined();
  const restored = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/superadmin/users/${target?.id}/password`,
    { data: { password: normalUser.password } }
  );
  expect(restored.ok()).toBe(true);
});

test("superadmin creates a user with a password from the users panel", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await page.getByRole("button", { name: "New user" }).click();

  const timestamp = Date.now();
  const createdUser = {
    displayLabel: `E2E Created ${timestamp}`,
    email: `e2e-created-${timestamp}@example.test`,
    password: `e2e-created-${timestamp}`
  };
  const dialog = page.getByRole("dialog", { name: "New user" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Display label").fill(createdUser.displayLabel);
  await dialog.getByLabel("Email").fill(createdUser.email);
  const initialPasswordInput = dialog.getByLabel("Initial password");
  await expect(initialPasswordInput).toHaveAttribute("type", "password");
  await initialPasswordInput.fill(createdUser.password);
  await dialog.getByRole("button", { name: "Show password" }).click();
  await expect(initialPasswordInput).toHaveAttribute("type", "text");
  await expect(initialPasswordInput).toHaveValue(createdUser.password);
  await dialog.getByRole("button", { name: "Hide password" }).click();
  await expect(initialPasswordInput).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Create user" }).click();
  const createdDialog = page.getByRole("dialog", { name: "User created" });
  await expect(createdDialog).toBeVisible();
  const createdPasswordInput = createdDialog.getByLabel("Initial password");
  await expect(createdPasswordInput).toHaveAttribute("type", "password");
  await createdDialog.getByRole("button", { name: "Show password" }).click();
  await expect(createdPasswordInput).toHaveAttribute("type", "text");
  await expect(createdPasswordInput).toHaveValue(createdUser.password);
  await page.getByRole("button", { name: "Open user" }).click();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toBeVisible();
  await expect(page.getByText("better-auth")).toBeVisible();

  await page.getByRole("button", { name: "E2E Superadmin account" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();

  await signInViaUi(
    page,
    { email: createdUser.email, password: createdUser.password },
    { alreadyOnLogin: true }
  );
  await expect(
    page.getByRole("button", { name: `${createdUser.displayLabel} account` })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open administration panel" })).toHaveCount(0);
});

test("superadmin deletes a user from the users panel", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await page.getByRole("button", { name: "Open administration panel" }).click();
  await expect(page.getByRole("region", { name: "Administration panel" })).toBeVisible();

  await page.getByRole("button", { name: /^Users/ }).click();
  await page.getByRole("button", { name: "New user" }).click();

  const timestamp = Date.now();
  const createdUser = {
    displayLabel: `E2E Deleted ${timestamp}`,
    email: `e2e-deleted-${timestamp}@example.test`,
    password: `e2e-deleted-${timestamp}`
  };
  const dialog = page.getByRole("dialog", { name: "New user" });
  await dialog.getByLabel("Display label").fill(createdUser.displayLabel);
  await dialog.getByLabel("Email").fill(createdUser.email);
  await dialog.getByLabel("Initial password").fill(createdUser.password);
  await dialog.getByRole("button", { name: "Create user" }).click();
  await page.getByRole("button", { name: "Open user" }).click();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete user" }).click();
  const deleteDialog = page.getByRole("dialog", { name: `Delete ${createdUser.displayLabel}?` });
  await expect(deleteDialog).toBeVisible();
  const confirmDeleteButton = deleteDialog.getByRole("button", {
    name: "Permanently delete user"
  });
  await expect(confirmDeleteButton).toBeDisabled();
  await deleteDialog.getByLabel("Confirmation").fill("wrong user");
  await expect(confirmDeleteButton).toBeDisabled();
  await deleteDialog.getByLabel("Confirmation").fill(createdUser.email);
  await expect(confirmDeleteButton).toBeEnabled();
  await confirmDeleteButton.click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toHaveCount(0);

  const usersResponse = await page.request.get(`${apiBaseUrl}/api/superadmin/users`);
  expect(usersResponse.ok()).toBe(true);
  const users = (await usersResponse.json()) as Array<{ email?: string }>;
  expect(users.some((user) => user.email === createdUser.email)).toBe(false);
});

/**
 * The rail lists a conversation only once it holds a message, so a conversation a test wants to
 * find there is created together with its first turn. The turn has finished when this returns:
 * no stream from the setup is still running when the test starts.
 */
async function createListedConversation(page: Page, title: string): Promise<{ id: string }> {
  const started = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/conversations/runs`, {
    data: {
      idempotencyKey: randomUUID(),
      conversation: { title },
      message: { text: `Opening message for ${title}` }
    }
  });
  expect(started.ok()).toBe(true);
  const { conversation } = (await started.json()) as { conversation: { id: string } };
  await expect
    .poll(async () => {
      const thread = await page.request.get(
        `${apiBaseUrl}/api/conversations/${encodeURIComponent(conversation.id)}/thread`
      );
      expect(thread.ok()).toBe(true);
      const snapshot = (await thread.json()) as { activeRun?: unknown; messages: unknown[] };
      return { running: snapshot.activeRun !== undefined, messages: snapshot.messages.length };
    })
    .toEqual({ running: false, messages: 2 });
  return conversation;
}

function legacyConversationPath(conversationId: string): string {
  return `/c/${encodeURIComponent(conversationId)}`;
}

const collaborationWorkspaceUrlPattern = /\/w\/[^/]+$/u;
const collaborationWorkspaceConversationUrlPattern = /\/w\/[^/]+\/c\/[^/]+$/u;

function conversationUrlPattern(conversationId: string): RegExp {
  return new RegExp(`/w/[^/]+/c/${escapeRegExp(encodeURIComponent(conversationId))}$`, "u");
}

function isRunEventsPath(pathname: string): boolean {
  return /^\/api\/conversations\/[^/]+\/runs\/[^/]+\/events$/u.test(pathname);
}

function currentConversationId(page: Page): string {
  const match = /^\/w\/[^/]+\/c\/([^/]+)$/u.exec(new URL(page.url()).pathname);
  if (!match?.[1]) {
    throw new Error(`Current route is not a conversation route: ${page.url()}`);
  }
  return decodeURIComponent(match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function signInViaUi(
  page: Page,
  user: { email: string; password: string },
  options: { alreadyOnLogin?: boolean } = {}
): Promise<void> {
  if (!options.alreadyOnLogin) {
    await page.goto("/");
  }
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/sign-in/email"
    ),
    page.getByRole("button", { name: "Sign in", exact: true }).click()
  ]);
  /*
   * The rail itself is the readiness signal. With collaboration workspace
   * chrome visible the client branding lives in the workspace selector popover
   * rather than in a branding row, so the rail no longer spells out the client
   * name.
   */
  await expect(
    page
      .getByRole("complementary", { name: "Conversations" })
      .getByRole("searchbox", { name: "Search conversations" })
  ).toBeVisible();
}

/**
 * Records every animation started inside the header, where the agent chip's flight is the
 * only source: its movement and its name's colour. Optionally pauses them at departure so
 * geometry and colour checks cannot miss a short flight.
 */
async function recordHeaderAnimations(
  page: Page,
  pauseAtDeparture = false
): Promise<() => Promise<string[]>> {
  await page.addInitScript((pauseAtDeparture) => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = animate.apply(this, args);
      if (this.closest("header")) {
        const { dataset } = document.documentElement;
        const seen: unknown = JSON.parse(dataset.headerAnimations ?? "[]");
        const [firstKeyframe] = Array.isArray(args[0]) ? args[0] : [];
        dataset.headerAnimations = JSON.stringify([
          ...(Array.isArray(seen) ? seen : []),
          String(firstKeyframe?.transform ?? "")
        ]);
        if (pauseAtDeparture) {
          animation.pause();
          animation.currentTime = 0;
        }
      }
      return animation;
    };
  }, pauseAtDeparture);
  return () =>
    page.evaluate(() => {
      const seen: unknown = JSON.parse(document.documentElement.dataset.headerAnimations ?? "[]");
      return Array.isArray(seen) ? seen.map(String) : [];
    });
}

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: {
      email: user.email,
      password: user.password,
      rememberMe: true
    }
  });
  expect(response.ok()).toBe(true);
}

async function ensureDarkMode(page: Page): Promise<void> {
  const isDark = await page
    .locator("main")
    .first()
    .evaluate((element) => element.classList.contains("dark"));
  if (!isDark) {
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
  }
  await expect
    .poll(() =>
      page
        .locator("main")
        .first()
        .evaluate((element) => element.classList.contains("dark"))
    )
    .toBe(true);
}

/** Opens a disclosure that may already be open; clicking an open one would close it. */
async function expandDisclosure(trigger: Locator): Promise<void> {
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

/**
 * A finished run keeps its tool calls in the work history, one level down in a group of their
 * own. Opens both and returns the card of the last tool call.
 */
async function openWorkHistoryToolCard(chatRegion: Locator): Promise<Locator> {
  await expandDisclosure(chatRegion.getByRole("button", { name: /^Work history/u }));
  await expandDisclosure(chatRegion.getByRole("button", { name: "1 tool call", exact: true }));
  const toolCallCard = chatRegion.getByTestId("tool-call-card").last();
  await expect(toolCallCard).toBeVisible();
  return toolCallCard;
}

async function stopActiveRun(page: Page): Promise<void> {
  const stopButton = page.getByRole("button", { name: "Stop generating" });
  if ((await stopButton.count()) === 0) {
    return;
  }
  await stopButton.click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 10_000 });
}

async function expectDocumentScrollLocked(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement;
        return {
          clientHeight: root.clientHeight,
          scrollHeight: root.scrollHeight,
          bodyOverflow: getComputedStyle(document.body).overflow
        };
      })
    )
    .toEqual(
      expect.objectContaining({
        bodyOverflow: "hidden"
      })
    );
  const dimensions = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return {
      clientHeight: root.clientHeight,
      scrollHeight: root.scrollHeight
    };
  });
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight + 1);
}
