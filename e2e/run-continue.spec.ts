import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  apiBaseUrl,
  createListedConversation,
  legacyConversationPath,
  test
} from "./chat-fixtures";
import { expect } from "./test";

// T6: a run the model provider stopped for too many requests offers its conversation's owner a
// "Weitermachen" button. It counts down the wait the notice names, then sends "weiter" once, the
// same message the person would write.

const wordsOf = {
  de: { notice: "Das Modell ist gerade überlastet", button: "Weitermachen", message: "weiter" },
  en: { notice: "The model is overloaded right now", button: "Continue", message: "continue" }
} as const;

for (const locale of ["de", "en"] as const) {
  test(`a rate-limited run goes on with one click after its wait (${locale})`, async ({
    page
  }, testInfo) => {
    test.setTimeout(120_000);
    const words = wordsOf[locale];
    await page.addInitScript((value) => {
      localStorage.setItem("vivd-catalyst:locale", value);
    }, locale);
    const conversation = await createListedConversation(page, `Rate limited ${locale}`);
    // The persisted failure a provider's 429 leaves once the worker's minute of waiting is over.
    // The provider's wire and retry behaviour is covered by the model-provider tests. The run
    // failed 48 seconds ago, so about 12 seconds of the wait are left.
    const failedAt = new Date(Date.now() - 48_000).toISOString();
    let continued = false;
    await page.route(
      `${apiBaseUrl}/api/v1/conversations/${conversation.id}/thread`,
      async (route) => {
        const response = await route.fetch();
        if (continued) return route.fulfill({ response });
        const snapshot = apiOperations["conversations.thread.get"].response.schema.parse(
          await response.json()
        );
        snapshot.activeRun = {
          run: {
            id: "run_rate_limited_e2e",
            conversationId: conversation.id,
            agentName: "application_assistant",
            status: "failed",
            startedAt: failedAt,
            updatedAt: failedAt,
            lastSequence: 2
          },
          projection: {
            runId: "run_rate_limited_e2e",
            status: "failed",
            lastSequence: 2,
            parts: [],
            text: "",
            reasoning: [],
            activeToolCalls: [],
            error: {
              code: "RATE_LIMITED",
              category: "app_error",
              message: "The model is receiving too many requests. Try again in a minute."
            }
          }
        };
        await route.fulfill({ response, json: snapshot });
      }
    );
    const runStarts: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url() === `${apiBaseUrl}/api/v1/conversations/${conversation.id}/runs`
      ) {
        runStarts.push(request.postData() ?? "");
      }
    });

    await page.goto(legacyConversationPath(conversation.id));
    const notice = page.getByText(words.notice, { exact: false });
    await expect(notice).toBeVisible();
    const button = page.getByTestId("run-continue");
    // While the wait lasts the button counts down and cannot be pressed.
    await expect(button).toBeDisabled();
    await expect(button).toContainText(new RegExp(`${words.button} in \\d+ s`, "u"));

    for (const width of [1280, 390]) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 700 });
        await page.evaluate((value) => localStorage.setItem("vivd-catalyst:theme", value), theme);
        await page.reload();
        await expect(notice).toBeVisible();
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
        const bounds = await button.boundingBox();
        if (!bounds) throw new Error("The continue button has no bounds");
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width
        );
        const file = testInfo.outputPath(`evidence-run-continue-${locale}-${width}-${theme}.png`);
        await page.screenshot({ path: file, animations: "disabled" });
        await testInfo.attach(`run-continue-${locale}-${width}-${theme}`, {
          path: file,
          contentType: "image/png"
        });
      }
    }

    // Once the wait is over it can be pressed, and it sends the word the notice asks for.
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await expect(button).toHaveText(words.button);
    expect(runStarts).toHaveLength(0);
    continued = true;
    await button.click();
    await expect.poll(() => runStarts.length).toBe(1);
    expect(JSON.parse(runStarts[0] ?? "{}")).toMatchObject({ message: { text: words.message } });
    await expect(
      page.locator('[data-role="user"]').getByText(words.message, { exact: true })
    ).toBeVisible();
    // The notice and its button go with the run that goes on; nothing is sent twice.
    await expect(button).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    expect(runStarts).toHaveLength(1);
  });
}
