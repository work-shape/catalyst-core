import { readFile } from "node:fs/promises";
import { test } from "./chat-fixtures";
import { expect } from "./test";

for (const locale of ["en", "de"] as const) {
  test(`HTML source attaches and downloads without running (${locale})`, async ({
    page
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.addInitScript((value) => {
      localStorage.setItem("vivd-catalyst:locale", value);
    }, locale);
    await page.goto("/");
    await page
      .getByRole("button", {
        name: locale === "de" ? "Neuer Chat" : "New chat",
        exact: true
      })
      .first()
      .click();
    const filename = "source.html";
    const source =
      '<!doctype html><html><body><h1>Source only</h1><script>document.body.dataset.sourceExecuted="yes";fetch("/source-executed")</script></body></html>';
    const executedRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("source-executed")) executedRequests.push(request.url());
    });
    const picker = page.locator('input[type="file"]');
    await expect(picker).toHaveAttribute("accept", /\.html/u);
    await picker.setInputFiles({
      name: filename,
      mimeType: "text/html",
      buffer: Buffer.from(source)
    });
    const send = page.getByRole("button", {
      name: locale === "de" ? "Nachricht senden" : "Send message"
    });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.locator('[data-role="user"]').last()).toContainText(filename);
    // The deterministic agent echoes the source manifest it received.
    await expect(
      page.getByRole("listitem").filter({ hasText: /^source\.html \(fileId: /u })
    ).toBeVisible();
    const conversationUrl = page.url();
    for (let visit = 0; visit < 2; visit += 1) {
      await page.goto("/");
      await page.goto(conversationUrl);
      await expect(page.locator('[data-role="user"]').last()).toContainText(filename);
    }
    const downloadButton = page
      .getByRole("button", {
        name: locale === "de" ? `${filename} herunterladen` : `Download ${filename}`,
        exact: true
      })
      .first();
    const pendingDownload = page.waitForEvent("download");
    await downloadButton.click();
    const download = await pendingDownload;
    expect(download.suggestedFilename()).toBe(filename);
    const path = await download.path();
    if (!path) throw new Error("The source download has no path");
    expect(await readFile(path, "utf8")).toBe(source);
    for (const width of [1280, 390]) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 600 });
        await page.evaluate((value) => localStorage.setItem("vivd-catalyst:theme", value), theme);
        await page.reload();
        const message = page.locator('[data-role="user"]').last();
        await message.scrollIntoViewIfNeeded();
        await expect(message).toContainText(filename);
        expect(executedRequests).toEqual([]);
        await expect(page.locator('[data-source-executed="yes"]')).toHaveCount(0);
        const picture = testInfo.outputPath(`evidence-source-${locale}-${width}-${theme}.png`);
        await page.screenshot({ path: picture, animations: "disabled" });
        await testInfo.attach(`source-${locale}-${width}-${theme}`, {
          path: picture,
          contentType: "image/png"
        });
      }
    }
  });
}
