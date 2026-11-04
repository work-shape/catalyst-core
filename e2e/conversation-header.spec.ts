import type { Page } from "@playwright/test";
import { test } from "./chat-fixtures";
import { expect } from "./test";

/** A conversation whose reply runs well past the window, in the locale and theme given. */
async function openLongConversation(
  page: Page,
  { width, locale, theme }: { width: number; locale: "en" | "de"; theme: "light" | "dark" },
  paragraph: (index: number) => string
) {
  await page.setViewportSize({ width, height: 640 });
  await page.addInitScript(
    ({ locale, theme }) => {
      localStorage.setItem("vivd-catalyst:locale", locale);
      localStorage.setItem("vivd-catalyst:theme", theme);
    },
    { locale, theme }
  );
  await page.goto("/");

  const composer = page.getByPlaceholder(locale === "de" ? "Nachricht" : "Message", {
    exact: true
  });
  await composer.fill(Array.from({ length: 24 }, (_, index) => paragraph(index + 1)).join("\n\n"));
  await composer.press("Enter");
  const reply = page.locator('[data-role="assistant"]').last();
  // The test model streams a word every 20 ms.
  await expect(reply).toContainText(paragraph(24), { timeout: 20_000 });
  await expect(
    page.getByRole("button", {
      name: locale === "de" ? "Generierung stoppen" : "Stop generating",
      exact: true
    })
  ).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-vivd-theme", theme);

  const picker = page.getByRole("button", { name: /^(Select agent|Agent auswählen):/u });
  await expect(picker).toBeVisible();
  const box = await picker.boundingBox();
  if (!box) throw new Error("The agent picker has no box");
  const viewport = page.locator(".chat-thread-inset");
  return { reply, box, viewport };
}

for (const width of [390, 767, 768, 1280, 1440]) {
  for (const locale of ["en", "de"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`conversation controls keep an opaque backdrop over scrolled text: ${width} ${locale} ${theme}`, async ({
        page
      }, testInfo) => {
        const { reply, box, viewport } = await openLongConversation(
          page,
          { width, locale, theme },
          (index) => `Backdrop review paragraph ${index}.`
        );
        // Put an assistant paragraph directly behind the picker, with more content below it.
        await viewport.evaluate((element, controls) => {
          const paragraph = element.querySelector('[data-role="assistant"] p');
          if (!paragraph) throw new Error("Missing paragraph");
          element.style.scrollBehavior = "auto";
          element.scrollTop +=
            paragraph.getBoundingClientRect().top -
            (controls.y + (controls.height - paragraph.getBoundingClientRect().height) / 2);
        }, box);
        await expect
          .poll(() =>
            reply
              .locator("p")
              .first()
              .evaluate((paragraph, controls) => {
                const rect = paragraph.getBoundingClientRect();
                return rect.top < controls.y + controls.height && rect.bottom > controls.y;
              }, box)
          )
          .toBe(true);
        expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

        // The pixels of the picker must be unchanged when the underlying thread is hidden.
        // This checks actual compositing, including transparency on any ancestor.
        const scrolled = await page.screenshot({ clip: box, animations: "disabled" });
        await page.screenshot({
          path: testInfo.outputPath(`evidence-header-${width}-${locale}-${theme}.png`),
          animations: "disabled"
        });
        await viewport.evaluate((element) => {
          element.style.opacity = "0";
        });
        const withoutThread = await page.screenshot({ clip: box, animations: "disabled" });
        expect(
          scrolled.equals(withoutThread),
          "scrolled text must not show through the agent picker"
        ).toBe(true);
      });
    }
  }
}

// Fails with a band across the top of a conversation: twice already (#210, then an opaque band
// for the controls) the thread stopped at the band's lower edge instead of scrolling to the
// window's top. From 768 px up a conversation alone reaches the top; only the controls cover it.
for (const width of [768, 1280, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`a conversation's content reaches the window's top beside the controls: ${width} ${theme}`, async ({
      page
    }, testInfo) => {
      const { reply, box, viewport } = await openLongConversation(
        page,
        { width, locale: "en", theme },
        (index) => `Top reach paragraph ${index}: its lines run well across the column.`
      );
      // A paragraph whose first line stands in the window's top 16 px.
      const paragraph = reply.locator("p").nth(3);
      const top = await paragraph.evaluate((element) => element.getBoundingClientRect().top);
      await viewport.evaluate((element, top) => {
        element.style.scrollBehavior = "auto";
        element.scrollTop += top + 2;
      }, top);
      await expect
        .poll(() =>
          paragraph.evaluate((element) => Math.round(element.getBoundingClientRect().top))
        )
        .toBeLessThanOrEqual(0);
      const rect = await paragraph.boundingBox();
      if (!rect) throw new Error("The paragraph has no box");

      // The strip of that line beside the controls must show the thread: hiding the thread
      // changes its pixels. A band over the window's top leaves them unchanged.
      const left = Math.max(rect.x, box.x + box.width + 16);
      const clip = { x: left, y: 0, width: rect.x + rect.width - left, height: 16 };
      expect(clip.width, "room beside the controls").toBeGreaterThan(100);
      const shown = await page.screenshot({ clip, animations: "disabled" });
      await page.screenshot({
        path: testInfo.outputPath(`evidence-top-${width}-${theme}.png`),
        animations: "disabled"
      });
      await viewport.evaluate((element) => {
        element.style.opacity = "0";
      });
      const hidden = await page.screenshot({ clip, animations: "disabled" });
      expect(shown.equals(hidden), "the thread must reach the window's top").toBe(false);
    });
  }
}
