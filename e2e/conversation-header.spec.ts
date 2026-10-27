import { test } from "./chat-fixtures";
import { expect } from "./test";

for (const width of [390, 767, 768, 1280, 1440]) {
  for (const locale of ["en", "de"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`conversation controls keep an opaque backdrop over scrolled text: ${width} ${locale} ${theme}`, async ({
        page
      }, testInfo) => {
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
        await composer.fill(
          Array.from({ length: 24 }, (_, index) => `Backdrop review paragraph ${index + 1}.`).join(
            "\n\n"
          )
        );
        await composer.press("Enter");
        const reply = page.locator('[data-role="assistant"]').last();
        await expect(reply).toContainText("Backdrop review paragraph 24.");
        await expect(
          page.getByRole("button", {
            name: locale === "de" ? "Generierung stoppen" : "Stop generating",
            exact: true
          })
        ).toHaveCount(0);
        await expect(page.locator("html")).toHaveAttribute("data-vivd-theme", theme);

        const picker = page.getByRole("button", {
          name: /^(Select agent|Agent auswählen):/u
        });
        await expect(picker).toBeVisible();
        const header = picker.locator("xpath=ancestor::header");
        const controls = await picker.boundingBox();
        expect(controls).not.toBeNull();
        const viewport = page.locator(".chat-thread-inset");
        // Put an assistant paragraph directly behind the picker, with more content below it.
        // A screenshot at the thread's start would miss the transparent desktop header.
        await viewport.evaluate((element, controls) => {
          const paragraph = element.querySelector('[data-role="assistant"] p');
          if (!paragraph || !controls) throw new Error("Missing paragraph or agent picker");
          element.style.scrollBehavior = "auto";
          element.scrollTop +=
            paragraph.getBoundingClientRect().top -
            (controls.y + (controls.height - paragraph.getBoundingClientRect().height) / 2);
        }, controls);
        await expect
          .poll(() =>
            reply
              .locator("p")
              .first()
              .evaluate((paragraph, controls) => {
                if (!controls) return false;
                const rect = paragraph.getBoundingClientRect();
                return (
                  rect.top < controls.y + controls.height &&
                  rect.bottom > controls.y &&
                  rect.left < controls.x + controls.width &&
                  rect.right > controls.x
                );
              }, controls)
          )
          .toBe(true);
        expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

        // The pixels behind the controls must be unchanged when the underlying thread is
        // hidden. This checks actual compositing, including transparency on any ancestor.
        const scrolled = await header.screenshot({ animations: "disabled" });
        await page.screenshot({
          path: testInfo.outputPath(`evidence-header-${width}-${locale}-${theme}.png`),
          animations: "disabled"
        });
        await viewport.evaluate((element) => {
          element.style.opacity = "0";
        });
        const withoutThread = await header.screenshot({ animations: "disabled" });
        expect(
          scrolled.equals(withoutThread),
          "scrolled text must not show through the header"
        ).toBe(true);
      });
    }
  }
}
