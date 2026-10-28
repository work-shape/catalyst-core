import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  apiBaseUrl,
  createListedConversation,
  legacyConversationPath,
  test
} from "./chat-fixtures";
import { expect } from "./test";

for (const locale of ["en", "de"] as const) {
  test(`interrupted stream explains how to continue (${locale})`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.addInitScript((value) => {
      localStorage.setItem("vivd-catalyst:locale", value);
    }, locale);
    const conversation = await createListedConversation(page, `Interrupted stream ${locale}`);
    // Supply the same persisted failure that an exhausted provider timeout leaves. The
    // provider wire/retry behavior is covered by model-stream-interruption.test.ts.
    await page.route(
      `${apiBaseUrl}/api/v1/conversations/${conversation.id}/thread`,
      async (route) => {
        const response = await route.fetch();
        const snapshot = apiOperations["conversations.thread.get"].response.schema.parse(
          await response.json()
        );
        const now = new Date().toISOString();
        snapshot.activeRun = {
          run: {
            id: "run_interrupted_e2e",
            conversationId: conversation.id,
            agentName: "application_assistant",
            status: "failed",
            startedAt: now,
            updatedAt: now,
            lastSequence: 2
          },
          projection: {
            runId: "run_interrupted_e2e",
            status: "failed",
            lastSequence: 2,
            parts: [],
            text: "",
            reasoning: [],
            activeToolCalls: [],
            error: {
              code: "TIMEOUT",
              category: "app_error",
              message: "Model provider stream ended before response.completed"
            }
          }
        };
        await route.fulfill({ response, json: snapshot });
      }
    );
    const notice =
      locale === "de"
        ? "Die Antwort wurde unterbrochen. Sie geht nicht von selbst weiter. Die erledigten Schritte bleiben erhalten: Schreib „weiter“, dann macht der Agent dort weiter, wo er aufgehört hat."
        : "The reply was interrupted. It does not continue on its own. The steps already done are kept: write “continue” and the agent picks up where it left off.";
    await page.goto(legacyConversationPath(conversation.id));
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
    const conversationUrl = page.url();
    for (let visit = 0; visit < 2; visit += 1) {
      await page.goto("/");
      await page.goto(conversationUrl);
      await expect(page.getByText(notice, { exact: true })).toBeVisible();
    }
    for (const width of [1280, 390]) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 600 });
        await page.evaluate((value) => localStorage.setItem("vivd-catalyst:theme", value), theme);
        await page.reload();
        const error = page.getByText(notice, { exact: true });
        await error.scrollIntoViewIfNeeded();
        await expect(error).toBeVisible();
        await expect(page.getByText("Model provider stream ended", { exact: false })).toHaveCount(
          0
        );
        const bounds = await error.boundingBox();
        if (!bounds) throw new Error("The interruption notice has no bounds");
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        const file = testInfo.outputPath(`evidence-stream-${locale}-${width}-${theme}.png`);
        await page.screenshot({ path: file, animations: "disabled" });
        await testInfo.attach(`stream-${locale}-${width}-${theme}`, {
          path: file,
          contentType: "image/png"
        });
      }
    }
  });
}
